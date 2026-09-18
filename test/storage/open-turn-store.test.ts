import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ElephaMcpService } from '../../src/mcp/tools.js';
import { filterTurn } from '../../src/rendering/filtered-turn.js';
import { SessionReader } from '../../src/serving/session-reader.js';
import { DurableEvictionPlan, storedProjectionBytes } from '../../src/storage/durable-capture-store.js';
import { sourceTurnDigest } from '../../src/storage/source-turn-digest.js';
import type { OpenTailObservation, ParsedTurn, SummarizationOutput } from '../../src/types/index.js';
import { createTestDb } from '../helpers/db.js';

function turn(projectPath: string, sourcePath: string, overrides: Partial<ParsedTurn> = {}): ParsedTurn {
    return {
        tool: 'codex',
        sessionId: 'open-native',
        sourcePath,
        projectPath,
        turnIndex: 0,
        startedAt: '2026-09-18T08:46:02.000Z',
        endedAt: '2026-09-18T08:47:17.715Z',
        userMessage: 'Investigate the issue.',
        assistantText: 'Partial investigation.',
        toolCalls: [],
        cursor: 'candidate-cursor',
        surface: 'codex-desktop',
        hasExternalContent: false,
        resumeMarkerBefore: false,
        validateSource: () => true,
        ...overrides,
    };
}

function observation(candidate: ParsedTurn, state: 'complete' | 'incomplete' = 'complete'): OpenTailObservation {
    return {
        kind: 'failed-eof',
        anchorCursor: undefined,
        candidateCursor: candidate.cursor,
        failedAt: candidate.endedAt,
        receiptCoverage: state === 'complete' ? { state, turn: candidate } : { state, reason: 'incomplete-correlation', turn: candidate },
    };
}

const source = (revision = 'revision-1') => ({
    dev: '1',
    ino: '2',
    size: 100,
    mtimeMs: 200,
    revision,
});

const summary: SummarizationOutput = {
    decisions: [{ what: 'avoid `unsafe`', why: null }],
    pending_items: ['retry $(later)'],
    status: 'ok',
};

function responseText(response: Awaited<ReturnType<ElephaMcpService['getSession']>>): string {
    return (response.content.find((block) => block.type === 'text') as { type: 'text'; text: string } | undefined)?.text ?? '';
}

describe('open turn staging', () => {
    it('counts a pending-only staged session by project', () => {
        const fixture = createTestDb('elepha-open-turn-counts-');
        const projectPath = path.join(fixture.directory, 'project');
        const sourcePath = path.join(fixture.directory, 'rollout.jsonl');
        fixture.store.consent.grant(projectPath);
        const candidate = turn(projectPath, sourcePath);
        fixture.store.observeOpenTurn(observation(candidate), { kind: 'main' }, 0, source(), '2026-09-18T08:47:18.000Z');
        expect(
            fixture.store.stageOpenTurnSummary(
                'codex',
                'open-native',
                'revision-1',
                sourceTurnDigest(candidate),
                summary,
                '2026-09-18T08:52:18.000Z',
                undefined,
                projectPath,
                () => true,
            ),
        ).toBe(true);

        const session = fixture.store.findSession('codex', 'open-native');
        expect(session).toBeDefined();
        expect(new SessionReader(fixture.db).sessionCountsByProject()).toEqual(new Map([[session!.project_id, 1]]));
    });

    it('keeps canonical cursor and memory empty, stages once by revision, and exposes an explicitly incomplete snapshot', async () => {
        const fixture = createTestDb('elepha-open-turn-');
        const projectPath = path.join(fixture.directory, 'project');
        const sourcePath = path.join(fixture.directory, 'rollout.jsonl');
        fixture.store.consent.grant(projectPath);
        const candidate = turn(projectPath, sourcePath);

        const row = fixture.store.observeOpenTurn(
            observation(candidate),
            { surface: 'desktop', kind: 'main' },
            0,
            source(),
            '2026-09-18T08:47:18.000Z',
        );

        expect(row).toBeDefined();
        expect(fixture.store.findSession('codex', 'open-native')).toMatchObject({
            cursor: null,
            rendered_chars: 0,
            rendered_turns: 0,
            title: null,
            first_prompt_search: null,
        });
        expect(fixture.db.prepare('SELECT COUNT(*) AS count FROM memories').get()).toEqual({ count: 0 });
        expect(fixture.db.prepare('SELECT COUNT(*) AS count FROM session_rollups').get()).toEqual({ count: 0 });
        expect(fixture.db.prepare('SELECT COUNT(*) AS count FROM session_embeddings').get()).toEqual({ count: 0 });
        expect(
            fixture.store.stageOpenTurnSummary(
                'codex',
                'open-native',
                'revision-1',
                sourceTurnDigest(candidate),
                summary,
                '2026-09-18T08:52:18.000Z',
                filterTurn(candidate),
                projectPath,
                () => true,
            ),
        ).toBe(true);
        expect(
            fixture.store.stageOpenTurnSummary(
                'codex',
                'open-native',
                'revision-1',
                sourceTurnDigest(candidate),
                summary,
                '2026-09-18T08:52:19.000Z',
                undefined,
                projectPath,
                () => true,
            ),
        ).toBe(false);

        const session = fixture.store.findSession('codex', 'open-native')!;
        const served = new SessionReader(fixture.db).sessionById(session.id)!;
        const snapshot = new SessionReader(fixture.db).incompleteLastObservedFor(served);
        expect(served).toMatchObject({ turn_count: 0, open_turn_staged_at: '2026-09-18T08:52:18.000Z' });
        expect(snapshot).toMatchObject({
            complete: false,
            turnIndex: 0,
            decisions: [{ what: 'avoid \\`unsafe\\`', why: null }],
            pendingItems: ['retry later'],
            durableProjection: { userPrompt: 'Investigate the issue.', assistantResponse: 'Partial investigation.' },
        });
        expect(
            (fixture.db.prepare('SELECT total_bytes FROM durable_capture_usage WHERE id = 1').get() as { total_bytes: number }).total_bytes,
        ).toBeGreaterThan(0);

        const mcp = new ElephaMcpService(fixture.db);
        const listed = mcp.listSessions({ project: projectPath });
        if (listed.structuredContent === undefined) {
            throw new Error('pending-only list_sessions response has no structured content');
        }
        const publicSession = (listed.structuredContent.sessions as Array<{ id: string; incomplete_last_observed?: true }>)[0]!;
        expect(publicSession.incomplete_last_observed).toBe(true);
        const servedText = responseText(await mcp.getSession({ id: publicSession.id }));
        expect(servedText).toContain('Incomplete last-observed snapshot');
        expect(servedText).toContain('"complete":false');
        expect(servedText).toContain('"filtered_interaction"');
        expect(servedText).toContain('Investigate the issue.');
    });

    it('keeps the staged summary but drops its recoverable projection when the durable byte cap binds', () => {
        const fixture = createTestDb('elepha-open-turn-durable-cap-');
        const projectPath = path.join(fixture.directory, 'project');
        const sourcePath = path.join(fixture.directory, 'rollout.jsonl');
        fixture.store.consent.grant(projectPath);
        const candidate = turn(projectPath, sourcePath);
        fixture.store.observeOpenTurn(observation(candidate), { kind: 'main' }, 0, source(), '2026-09-18T08:47:18.000Z');

        expect(
            fixture.store.stageOpenTurnSummary(
                'codex',
                'open-native',
                'revision-1',
                sourceTurnDigest(candidate),
                summary,
                '2026-09-18T08:52:18.000Z',
                filterTurn(candidate),
                projectPath,
                () => true,
                1,
            ),
        ).toBe(true);

        expect(fixture.store.findOpenTurn('codex', 'open-native')).toMatchObject({
            staged_at: '2026-09-18T08:52:18.000Z',
            durable_included: null,
            durable_user_prompt: null,
        });
        expect(fixture.db.prepare('SELECT total_bytes FROM durable_capture_usage WHERE id = 1').get()).toEqual({ total_bytes: 0 });
    });

    it('evicts an older recoverable canonical capture before a newer staged projection', () => {
        const fixture = createTestDb('elepha-open-turn-mixed-eviction-');
        const projectPath = path.join(fixture.directory, 'project');
        const project = fixture.store.upsertProject(projectPath);
        fixture.store.consent.grant(projectPath);
        const canonicalSource = path.join(fixture.directory, 'canonical.jsonl');
        const canonicalSession = fixture.store.upsertSession('codex', 'canonical-native', project.id, canonicalSource);
        const canonical = turn(projectPath, canonicalSource, { sessionId: 'canonical-native' });
        fixture.store.recordTurn(canonical, canonicalSession.id, project.id, summary, true);
        fixture.db.prepare('UPDATE sessions SET last_ingested_at = ? WHERE id = ?').run('2026-01-01T00:00:00.000Z', canonicalSession.id);

        const stagedSource = path.join(fixture.directory, 'staged.jsonl');
        const stagedCandidate = turn(projectPath, stagedSource, { sessionId: 'staged-native' });
        const stagedRow = fixture.store.observeOpenTurn(
            observation(stagedCandidate),
            { kind: 'main' },
            0,
            source(),
            '2026-09-18T08:47:18.000Z',
        )!;
        const projection = filterTurn(stagedCandidate);
        const plan = DurableEvictionPlan.from(
            new Map([
                [
                    `session:${canonicalSession.id}`,
                    {
                        kind: 'session' as const,
                        id: canonicalSession.id,
                        tool: 'codex' as const,
                        source_path: canonicalSource,
                        recoverable: true,
                    },
                ],
            ]),
            {
                kind: 'open-turn',
                id: stagedRow.session_id,
                tool: 'codex',
                source_path: stagedSource,
                recoverable: true,
            },
        );

        expect(
            fixture.store.stageOpenTurnSummary(
                'codex',
                'staged-native',
                'revision-1',
                sourceTurnDigest(stagedCandidate),
                summary,
                '2026-09-18T08:52:18.000Z',
                projection,
                projectPath,
                () => true,
                storedProjectionBytes(projection),
                undefined,
                plan,
            ),
        ).toBe(true);
        expect(fixture.db.prepare('SELECT COUNT(*) AS count FROM filtered_turns').get()).toEqual({ count: 0 });
        expect(fixture.store.findOpenTurn('codex', 'staged-native')?.durable_user_prompt).toBe(stagedCandidate.userMessage);
    });

    it('evicts the oldest recoverable staged projection before a newer staged projection', () => {
        const fixture = createTestDb('elepha-open-turn-staged-eviction-');
        const projectPath = path.join(fixture.directory, 'project');
        fixture.store.consent.grant(projectPath);
        const first = turn(projectPath, path.join(fixture.directory, 'first.jsonl'), { sessionId: 'first-open' });
        const second = turn(projectPath, path.join(fixture.directory, 'second.jsonl'), { sessionId: 'second-open' });
        const firstRow = fixture.store.observeOpenTurn(observation(first), { kind: 'main' }, 0, source(), '2026-09-18T08:47:18.000Z')!;
        expect(
            fixture.store.stageOpenTurnSummary(
                'codex',
                'first-open',
                'revision-1',
                sourceTurnDigest(first),
                summary,
                '2026-09-18T08:52:18.000Z',
                filterTurn(first),
            ),
        ).toBe(true);
        const secondRow = fixture.store.observeOpenTurn(observation(second), { kind: 'main' }, 0, source(), '2026-09-18T09:00:00.000Z')!;
        const secondProjection = filterTurn(second);
        const plan = DurableEvictionPlan.from(
            new Map([
                [
                    `open-turn:${firstRow.session_id}`,
                    {
                        kind: 'open-turn' as const,
                        id: firstRow.session_id,
                        tool: 'codex' as const,
                        source_path: first.sourcePath,
                        recoverable: true,
                    },
                ],
            ]),
            {
                kind: 'open-turn',
                id: secondRow.session_id,
                tool: 'codex',
                source_path: second.sourcePath,
                recoverable: true,
            },
        );

        expect(
            fixture.store.stageOpenTurnSummary(
                'codex',
                'second-open',
                'revision-1',
                sourceTurnDigest(second),
                summary,
                '2026-09-18T09:05:00.000Z',
                secondProjection,
                projectPath,
                () => true,
                storedProjectionBytes(secondProjection),
                undefined,
                plan,
            ),
        ).toBe(true);
        expect(fixture.store.findOpenTurn('codex', 'first-open')).toMatchObject({ staged_at: '2026-09-18T08:52:18.000Z' });
        expect(fixture.store.findOpenTurn('codex', 'first-open')?.durable_user_prompt).toBeNull();
        expect(fixture.store.findOpenTurn('codex', 'second-open')?.durable_user_prompt).toBe(second.userMessage);
    });

    it('revises one row for repeated failures and prevents a stale same-metadata summary from winning', () => {
        const fixture = createTestDb('elepha-open-turn-revision-');
        const projectPath = path.join(fixture.directory, 'project');
        const sourcePath = path.join(fixture.directory, 'rollout.jsonl');
        fixture.store.consent.grant(projectPath);
        const first = turn(projectPath, sourcePath);
        fixture.store.observeOpenTurn(observation(first), { kind: 'main' }, 0, source(), '2026-09-18T08:47:18.000Z');
        expect(
            fixture.store.stageOpenTurnSummary(
                'codex',
                'open-native',
                'revision-1',
                sourceTurnDigest(first),
                summary,
                '2026-09-18T08:52:18.000Z',
                undefined,
                projectPath,
                () => true,
            ),
        ).toBe(true);
        const second = turn(projectPath, sourcePath, {
            assistantText: 'Second failed attempt.',
            endedAt: '2026-09-18T09:00:00.000Z',
            cursor: 'candidate-cursor-2',
        });
        fixture.store.observeOpenTurn(observation(second), { kind: 'main' }, 0, source(), '2026-09-18T09:00:01.000Z');

        expect(fixture.db.prepare('SELECT COUNT(*) AS count FROM open_turns').get()).toEqual({ count: 1 });
        expect(fixture.store.findOpenTurn('codex', 'open-native')).toMatchObject({
            source_revision: 'revision-1',
            candidate_cursor: 'candidate-cursor-2',
            staged_at: null,
        });
        expect(
            fixture.store.stageOpenTurnSummary(
                'codex',
                'open-native',
                'revision-1',
                sourceTurnDigest(first),
                summary,
                '2026-09-18T09:05:00.000Z',
                undefined,
                projectPath,
                () => true,
            ),
        ).toBe(false);
    });

    it('publishes failed-EOF MCP receipts without cursor advancement and retains them after retry-to-drop closure', () => {
        const fixture = createTestDb('elepha-open-turn-receipt-');
        const projectPath = path.join(fixture.directory, 'project');
        const sourcePath = path.join(fixture.directory, 'rollout.jsonl');
        fixture.store.consent.grant(projectPath);
        const candidate = turn(projectPath, sourcePath, {
            droppedReason: 'elepha-mcp',
            elephaMcpResultReceipts: [{ callId: 'call-1', body: 'receipt body', observedAt: '2026-09-18T08:47:00.000Z' }],
        });

        fixture.store.observeOpenTurn(observation(candidate), { kind: 'main' }, 0, source(), '2026-09-18T08:47:18.000Z');

        expect(fixture.store.findSession('codex', 'open-native')?.cursor).toBeNull();
        expect(fixture.store.mcpReceiptsForSession('codex', 'open-native', 0)).toHaveLength(1);
        expect(fixture.store.recordDroppedTurn(candidate, { kind: 'main' })).toBe(true);
        expect(fixture.store.findOpenTurn('codex', 'open-native')).toBeUndefined();
        expect(fixture.store.findSession('codex', 'open-native')?.cursor).toBe('candidate-cursor');
        expect(fixture.store.mcpReceiptsForSession('codex', 'open-native', 0)).toHaveLength(1);
    });

    it('fails closed on incomplete receipt coverage and removes staged content on incognito deletion', () => {
        const fixture = createTestDb('elepha-open-turn-privacy-');
        const projectPath = path.join(fixture.directory, 'project');
        const sourcePath = path.join(fixture.directory, 'rollout.jsonl');
        fixture.store.consent.grant(projectPath);
        const candidate = turn(projectPath, sourcePath);
        fixture.store.observeOpenTurn(observation(candidate, 'incomplete'), { kind: 'main' }, 0, source(), '2026-09-18T08:47:18.000Z');

        expect(
            fixture.store.stageOpenTurnSummary(
                'codex',
                'open-native',
                'revision-1',
                sourceTurnDigest(candidate),
                summary,
                '2026-09-18T08:52:18.000Z',
                undefined,
                projectPath,
                () => true,
            ),
        ).toBe(false);
        fixture.store.recordIncognitoTranscript('codex', 'open-native');
        expect(fixture.store.findOpenTurn('codex', 'open-native')).toBeUndefined();
    });

    it('does not stage a failed EOF that quotes elepha-injected context', () => {
        const fixture = createTestDb('elepha-open-turn-quote-back-');
        const projectPath = path.join(fixture.directory, 'project');
        const sourcePath = path.join(fixture.directory, 'rollout.jsonl');
        fixture.store.consent.grant(projectPath);
        fixture.store.recordInjection({
            tool: 'codex',
            nativeSessionId: 'open-native',
            injectedAt: '2026-09-18T08:46:00.000Z',
            injectionId: '01J00000000000000000000000',
            body: 'Investigate the issue.',
        });
        const candidate = turn(projectPath, sourcePath);

        expect(
            fixture.store.observeOpenTurn(observation(candidate), { kind: 'main' }, 0, source(), '2026-09-18T08:47:18.000Z'),
        ).toBeUndefined();
        expect(fixture.store.findOpenTurn('codex', 'open-native')).toBeUndefined();
    });

    it('keeps revocation distinct from deletion and includes staging in the purge preview and apply', () => {
        const fixture = createTestDb('elepha-open-turn-purge-');
        const projectPath = path.join(fixture.directory, 'project');
        const sourcePath = path.join(fixture.directory, 'rollout.jsonl');
        fixture.store.consent.grant(projectPath);
        const candidate = turn(projectPath, sourcePath);
        fixture.store.observeOpenTurn(observation(candidate), { kind: 'main' }, 0, source(), '2026-09-18T08:47:18.000Z');
        fixture.store.stageOpenTurnSummary(
            'codex',
            'open-native',
            'revision-1',
            sourceTurnDigest(candidate),
            summary,
            '2026-09-18T08:52:18.000Z',
            filterTurn(candidate),
            projectPath,
            () => true,
        );

        fixture.store.consent.revoke(projectPath);
        expect(fixture.store.findOpenTurn('codex', 'open-native')).toBeDefined();
        const project = fixture.store.findProject(projectPath)!;
        const plan = fixture.store.planPurge({ projectIds: [project.id] });
        expect(plan.sessions).toHaveLength(1);
        expect(plan.sessions[0]).toMatchObject({ turnCount: 0, filteredTurnCount: 1 });
        expect(plan.sessions[0]!.filteredBytes).toBeGreaterThan(0);

        fixture.store.applyPurgePlan(plan);
        expect(fixture.store.findOpenTurn('codex', 'open-native')).toBeUndefined();
        expect(fixture.store.isTranscriptPurged('codex', 'open-native')).toBe(true);
        expect(fixture.db.prepare('SELECT total_bytes FROM durable_capture_usage WHERE id = 1').get()).toEqual({ total_bytes: 0 });
    });

    it('removes the matching staging row atomically when the late retry becomes canonical', () => {
        const fixture = createTestDb('elepha-open-turn-finalize-');
        const projectPath = path.join(fixture.directory, 'project');
        const sourcePath = path.join(fixture.directory, 'rollout.jsonl');
        fixture.store.consent.grant(projectPath);
        const candidate = turn(projectPath, sourcePath);
        fixture.store.observeOpenTurn(observation(candidate), { kind: 'main' }, 0, source(), '2026-09-18T08:47:18.000Z');
        const finalized = turn(projectPath, sourcePath, { assistantText: 'Final answer.', cursor: 'final-cursor' });
        const validate = vi.fn(() => true);
        finalized.validateSource = validate;

        const result = fixture.store.recordIngestedTurn(finalized, { kind: 'main' }, false, {
            decisions: [],
            pending_items: [],
            status: 'ok',
        });

        expect(result?.inserted).toBe(true);
        expect(validate).toHaveBeenCalled();
        expect(fixture.store.findOpenTurn('codex', 'open-native')).toBeUndefined();
        expect(fixture.store.findSession('codex', 'open-native')?.cursor).toBe('final-cursor');
        expect(fixture.db.prepare('SELECT COUNT(*) AS count FROM memories').get()).toEqual({ count: 1 });
    });
});
