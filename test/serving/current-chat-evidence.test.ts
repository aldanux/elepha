import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
    CURRENT_CHAT_EVIDENCE_MAX_CHARS,
    CURRENT_CHAT_EVIDENCE_MAX_SEGMENT_READS,
    DURABLE_CAPTURE_FILTER_VERSION,
    SESSION_EVIDENCE_SOURCE_MAX_BYTES,
} from '../../src/config/constants.js';
import { currentChatEvidence } from '../../src/serving/current-chat-evidence.js';
import { SessionReader } from '../../src/serving/session-reader.js';
import { createTestDb, seedConsentRoot, seedCopyCoverage, seedMemory, seedProject, seedSession } from '../helpers/db.js';

function fixture() {
    const f = createTestDb('current-chat-evidence-');
    const checkout = path.join(f.directory, 'checkout');
    mkdirSync(checkout, { recursive: true });
    const project = seedProject(f, { path: checkout });
    seedConsentRoot(f, { path: checkout });
    return { ...f, checkout, project };
}

function capture(
    f: ReturnType<typeof fixture>,
    session: ReturnType<typeof seedSession>,
    project: ReturnType<typeof seedProject>,
    turnIndex: number,
    user: string,
    assistant: string,
) {
    const memory = seedMemory(f, { project, session, turnIndex, userMessage: user, assistantText: assistant });
    f.db
        .prepare(`INSERT INTO filtered_turns
            (memory_id, included, user_prompt, assistant_response, tool_calls, omitted_tool_call_count,
             dropped_tool_ref_count, omitted_before_chars, filter_version, captured_at)
            VALUES (?, 1, ?, ?, '[]', 0, 0, 0, ?, '2026-09-27')`)
        .run(memory.id, user, assistant, DURABLE_CAPTURE_FILTER_VERSION);
    seedCopyCoverage(f, memory.id);
    f.db
        .prepare(`INSERT INTO durable_capture_status (session_id, state, filter_version, updated_at)
            VALUES (?, 'complete', ?, '2026-09-27')
            ON CONFLICT(session_id) DO UPDATE SET state = 'complete', filter_version = excluded.filter_version`)
        .run(session.id, DURABLE_CAPTURE_FILTER_VERSION);
}

describe('current chat evidence', () => {
    it('serves retained current-chat evidence and rejects a substituted adjacent stored chat', async () => {
        const f = fixture();
        const session = seedSession(f, { project: f.project, nativeId: 'stored-chat' });
        capture(f, session, f.project, 0, 'Keep the stored decision', 'The stored decision remains.');
        const input = { tool: 'codex' as const, nativeSessionId: 'stored-chat', cwd: f.checkout, mode: 'continuation' as const };
        expect(await currentChatEvidence(f.db, input)).toMatchObject({
            state: 'available',
            evidence: [{ userPrompt: 'Keep the stored decision' }],
        });
        f.db.prepare('UPDATE sessions SET native_id = ? WHERE id = ?').run('adjacent-chat', session.id);
        expect(await currentChatEvidence(f.db, input)).toEqual({ state: 'unavailable', reason: 'current_chat_not_ingested' });
    });

    it('keeps complete newest OpenCode pairs from durable capture when the serving budget drops older turns', async () => {
        const f = fixture();
        const session = seedSession(f, { project: f.project, tool: 'opencode', nativeId: 'ses_primary' });
        for (let turnIndex = 0; turnIndex < 300; turnIndex++) {
            capture(f, session, f.project, turnIndex, `Prompt ${turnIndex}`, `Answer ${turnIndex}`);
        }
        const result = await currentChatEvidence(f.db, {
            tool: 'opencode',
            nativeSessionId: 'ses_primary',
            cwd: f.checkout,
            mode: 'continuation',
        });
        expect(result.state).toBe('available');
        if (result.state !== 'available') return;
        expect(result.evidence[0]).toMatchObject({
            turnIndex: 299,
            userPrompt: 'Prompt 299',
            assistantResponse: 'Answer 299',
        });
        expect(result.partialCoverage).toBe(true);
        expect(result.omittedTurnCount).toBeGreaterThan(0);
    });

    it.each(['codex', 'opencode'] as const)(
        'serves fresh %s durable evidence but abstains after reingest leaves it stale',
        async (tool) => {
            const f = fixture();
            const session = seedSession(f, { project: f.project, tool, nativeId: 'reingested-chat' });
            capture(f, session, f.project, 0, 'Keep the original decision', 'The original decision stands.');
            const request = { tool, nativeSessionId: 'reingested-chat', cwd: f.checkout, mode: 'continuation' as const };
            expect(await currentChatEvidence(f.db, request)).toMatchObject({
                state: 'available',
                evidence: [{ userPrompt: 'Keep the original decision' }],
            });

            f.db.prepare('UPDATE filtered_turns SET captured_at = ?').run('2000-01-01T00:00:00.000Z');
            expect(
                f.store.reingestTurn(
                    {
                        tool,
                        sessionId: 'reingested-chat',
                        sourcePath: session.source_path,
                        projectPath: f.checkout,
                        turnIndex: 0,
                        startedAt: '2026-08-01T00:00:00.000Z',
                        endedAt: '2026-08-01T00:00:00.000Z',
                        userMessage: 'Use the revised decision',
                        assistantText: 'The revised decision replaces the old one.',
                        toolCalls: [],
                        cursor: '0',
                        hasExternalContent: false,
                        resumeMarkerBefore: false,
                    },
                    session.id,
                    f.project.id,
                    { decisions: [], pending_items: [], status: 'not_configured' },
                ),
            ).toBe(true);
            expect(await currentChatEvidence(f.db, request)).toEqual({ state: 'unavailable', reason: 'durable_turn_stale_after_reingest' });
        },
    );

    it('finds source turns across native-chat segments without a model provider or source transcript', async () => {
        const f = fixture();
        const first = seedSession(f, { project: f.project, nativeId: 'native-chat', sourcePath: path.join(f.directory, 'missing.jsonl') });
        capture(f, first, f.project, 0, 'Keep the signed receipt for every refund', 'Agreed: retain signed receipts.');
        const second = f.store.startNextSegment(first, f.project.id, first.source_path);
        capture(f, second, f.project, 1, 'Continue the refund work', 'I will continue with the receipt requirement.');
        const adjacent = seedSession(f, { project: f.project, nativeId: 'adjacent-chat' });
        capture(f, adjacent, f.project, 0, 'Erase all receipts', 'This belongs to another chat.');

        const result = await currentChatEvidence(f.db, {
            tool: 'codex',
            nativeSessionId: 'native-chat',
            cwd: f.checkout,
            mode: 'query',
            query: 'signed',
        });
        expect(result.state).toBe('available');
        if (result.state !== 'available') return;
        expect(result.evidence).toEqual([
            {
                segmentIndex: 0,
                turnIndex: 0,
                userPrompt: 'Keep the signed receipt for every refund',
                assistantResponse: 'Agreed: retain signed receipts.',
            },
        ]);
        expect(JSON.stringify(result)).not.toContain('Erase all receipts');
        expect(JSON.stringify(result)).not.toContain('another chat');
    });

    it('keeps two consented worktrees separate even when stored project identities share a remote', async () => {
        const f = fixture();
        const otherCheckout = path.join(f.directory, 'other-worktree');
        mkdirSync(otherCheckout);
        const otherProject = seedProject(f, { path: otherCheckout });
        seedConsentRoot(f, { path: otherCheckout });
        f.db
            .prepare('UPDATE projects SET git_remote = ? WHERE id IN (?, ?)')
            .run('https://example.test/repo.git', f.project.id, otherProject.id);
        const current = seedSession(f, { project: f.project, nativeId: 'shared-native' });
        capture(f, current, f.project, 0, 'Keep the local decision', 'Local checkout answer.');
        const other = f.store.startNextSegment(current, otherProject.id, current.source_path);
        capture(f, other, otherProject, 1, 'Secret decision from sibling worktree', 'Do not expose this.');

        const result = await currentChatEvidence(f.db, {
            tool: 'codex',
            nativeSessionId: 'shared-native',
            cwd: f.checkout,
            mode: 'continuation',
        });
        expect(result.state).toBe('available');
        if (result.state !== 'available') return;
        expect(result.evidence.map((turn) => turn.userPrompt)).toEqual(['Keep the local decision']);
    });

    it('rechecks consent after an awaited source read', async () => {
        const f = fixture();
        const session = seedSession(f, { project: f.project, nativeId: 'consent-race' });
        capture(f, session, f.project, 0, 'Keep the agreed scope', 'The scope remains.');
        const reader = new SessionReader(f.db);
        const read = reader.indexedEvidenceWindow.bind(reader);
        vi.spyOn(reader, 'indexedEvidenceWindow').mockImplementation(async (...args) => {
            const result = await read(...args);
            f.store.consent.revoke(f.checkout);
            return result;
        });

        expect(
            await currentChatEvidence(
                f.db,
                {
                    tool: 'codex',
                    nativeSessionId: 'consent-race',
                    cwd: f.checkout,
                    mode: 'continuation',
                },
                reader,
            ),
        ).toEqual({ state: 'unavailable', reason: 'current_chat_authorization_changed' });
    });

    it('distinguishes not ingested from unavailable Codex and OpenCode sources', async () => {
        const f = fixture();
        expect(
            await currentChatEvidence(f.db, {
                tool: 'codex',
                nativeSessionId: 'missing',
                cwd: f.checkout,
                mode: 'continuation',
            }),
        ).toEqual({ state: 'unavailable', reason: 'current_chat_not_ingested' });

        const codex = seedSession(f, {
            project: f.project,
            nativeId: 'source-missing',
            sourcePath: path.join(f.directory, 'missing.jsonl'),
        });
        seedMemory(f, { project: f.project, session: codex, turnIndex: 0 });
        const source = await currentChatEvidence(f.db, {
            tool: 'codex',
            nativeSessionId: 'source-missing',
            cwd: f.checkout,
            mode: 'continuation',
        });
        expect(source).toMatchObject({ state: 'unavailable' });
        expect(source.state === 'unavailable' && source.reason).not.toBe('current_chat_not_ingested');

        const opencode = seedSession(f, { project: f.project, tool: 'opencode', nativeId: 'opencode-source' });
        seedMemory(f, { project: f.project, session: opencode, turnIndex: 0 });
        expect(
            await currentChatEvidence(f.db, {
                tool: 'opencode',
                nativeSessionId: 'opencode-source',
                cwd: f.checkout,
                mode: 'continuation',
            }),
        ).toEqual({ state: 'unavailable', reason: 'opencode_source_identity_unverified' });
    });

    it('bounds returned pairs and rejects incognito sessions at use time', async () => {
        const f = fixture();
        const session = seedSession(f, { project: f.project, nativeId: 'bounded-chat' });
        for (let turnIndex = 0; turnIndex < 8; turnIndex++) {
            capture(f, session, f.project, turnIndex, `Decision ${turnIndex}`, `Explanation ${turnIndex}: ${'x'.repeat(500)}`);
        }
        const request = { tool: 'codex' as const, nativeSessionId: 'bounded-chat', cwd: f.checkout, mode: 'continuation' as const };
        const result = await currentChatEvidence(f.db, request);
        expect(result.state).toBe('available');
        if (result.state !== 'available') return;
        expect(result.evidence.length).toBeLessThanOrEqual(3);
        expect(result.evidence[0]?.turnIndex).toBe(7);
        expect(
            result.evidence.reduce((total, turn) => total + turn.userPrompt.length + turn.assistantResponse.length, 0),
        ).toBeLessThanOrEqual(CURRENT_CHAT_EVIDENCE_MAX_CHARS);

        f.store.recordIncognitoTranscript('codex', 'bounded-chat');
        expect(await currentChatEvidence(f.db, request)).toEqual({ state: 'unavailable', reason: 'current_chat_not_ingested' });
    });

    it('rejects an oversized durable row before transferring its text to the reader', async () => {
        const f = fixture();
        const session = seedSession(f, { project: f.project, nativeId: 'oversized-chat' });
        capture(f, session, f.project, 0, 'small prompt', 'small response');
        f.db.prepare('UPDATE filtered_turns SET assistant_response = ?').run('x'.repeat(SESSION_EVIDENCE_SOURCE_MAX_BYTES + 1));

        expect(
            await currentChatEvidence(f.db, {
                tool: 'codex',
                nativeSessionId: 'oversized-chat',
                cwd: f.checkout,
                mode: 'continuation',
            }),
        ).toEqual({ state: 'unavailable', reason: 'evidence_source_byte_budget' });
    });

    it('reports older segments omitted when the aggregate read budget binds', async () => {
        const f = fixture();
        let session = seedSession(f, { project: f.project, nativeId: 'many-segments' });
        for (let index = 0; index <= CURRENT_CHAT_EVIDENCE_MAX_SEGMENT_READS; index++) {
            if (index > 0) session = f.store.startNextSegment(session, f.project.id, session.source_path);
            capture(f, session, f.project, index, `Prompt ${index}`, `Answer ${index}`);
        }
        const reader = new SessionReader(f.db);
        const read = vi.spyOn(reader, 'indexedEvidenceWindow');
        const result = await currentChatEvidence(
            f.db,
            {
                tool: 'codex',
                nativeSessionId: 'many-segments',
                cwd: f.checkout,
                mode: 'continuation',
            },
            reader,
        );
        expect(read).toHaveBeenCalledTimes(CURRENT_CHAT_EVIDENCE_MAX_SEGMENT_READS);
        expect(result).toMatchObject({ state: 'available', partialCoverage: true, partialCoverageReason: 'older_segments_not_read' });
    });

    it('retains an older stronger query match after the candidate budget binds', async () => {
        const f = fixture();
        const session = seedSession(f, { project: f.project, nativeId: 'older-decision' });
        capture(f, session, f.project, 0, 'Approve signed receipt retention', 'Keep signed receipt retention.');
        for (let index = 1; index <= 12; index++) {
            capture(f, session, f.project, index, `Receipt note ${index}`, 'No decision here.');
        }
        const result = await currentChatEvidence(f.db, {
            tool: 'codex',
            nativeSessionId: 'older-decision',
            cwd: f.checkout,
            mode: 'query',
            query: 'signed receipt retention',
        });
        expect(result.state).toBe('available');
        if (result.state !== 'available') return;
        expect(result.evidence[0]).toMatchObject({ turnIndex: 0, userPrompt: 'Approve signed receipt retention' });
    });

    it('does not report a definitive miss when a long chat hides an older query match', async () => {
        const f = fixture();
        const session = seedSession(f, { project: f.project, nativeId: 'long-query-chat' });
        capture(f, session, f.project, 0, 'Approve rare-marker retention', 'Agreed.');
        for (let turnIndex = 1; turnIndex < 120; turnIndex++) {
            capture(f, session, f.project, turnIndex, `Routine ${turnIndex}`, `Progress ${'x'.repeat(1_000)}`);
        }
        expect(
            await currentChatEvidence(f.db, {
                tool: 'codex',
                nativeSessionId: 'long-query-chat',
                cwd: f.checkout,
                mode: 'query',
                query: 'rare-marker',
            }),
        ).toEqual({ state: 'unavailable', reason: 'older_turns_not_searched' });
    });
});
