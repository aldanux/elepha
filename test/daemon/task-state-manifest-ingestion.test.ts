import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClaudeCodeAdapter } from '../../src/adapters/claude-code.js';
import { DEFAULT_MEMORY_CONFIG } from '../../src/config/memory-config.js';
import { setSetting } from '../../src/config/settings.js';
import { IngestionDaemon } from '../../src/daemon/index.js';
import { TaskStateManifestStore } from '../../src/storage/task-state-manifest-store.js';
import { TaskStateRequestStore, taskStateRequestMarker } from '../../src/storage/task-state-request-store.js';
import type { ParsedTurn } from '../../src/types/index.js';
import { createTestDb } from '../helpers/db.js';

const report = {
    callId: 'report-1',
    mode: 'precompact_manifest' as const,
    request_id: '01J00000000000000000000000',
    objective: { text: 'Keep the source quote', sources: [{ role: 'user' as const, quote: 'Keep the source quote' }] },
    decisions: [],
    constraints: [],
    pending_items: [],
};

function fixture(enabled = true) {
    const f = createTestDb('task-state-manifest-ingestion-');
    vi.stubEnv('ELEPHA_HOME', f.directory);
    setSetting('memory-plus', enabled ? 'true' : 'false');
    const projectPath = path.join(f.directory, 'checkout');
    mkdirSync(projectPath);
    f.store.consent.grant(projectPath);
    const sourcePath = path.join(f.directory, 'session.jsonl');
    const logs: string[] = [];
    const summarizer = { summarize: vi.fn(async () => ({ decisions: [], pending_items: [], status: 'ok' as const })) };
    const daemon = new IngestionDaemon({
        store: f.store,
        summarizer,
        readConfig: () => ({ config: { ...DEFAULT_MEMORY_CONFIG, durableCapture: true } }),
        logError: (message) => logs.push(message),
    });
    const adapter = new ClaudeCodeAdapter();
    const persist = (turn: ParsedTurn, kind: 'primary' | 'sub-agent' = 'primary') =>
        (
            daemon as unknown as {
                persistTurn(
                    adapter: ClaudeCodeAdapter,
                    turn: ParsedTurn,
                    title: undefined,
                    classification: { kind: string },
                ): Promise<boolean>;
            }
        ).persistTurn(adapter, turn, undefined, { kind });
    const turn = (turnIndex: number, overrides: Partial<ParsedTurn> = {}): ParsedTurn => ({
        tool: 'claude-code',
        sessionId: 'manifest-chat',
        sourcePath,
        projectPath,
        turnIndex,
        startedAt: `2026-09-28T00:00:0${turnIndex}.000Z`,
        endedAt: `2026-09-28T00:00:0${turnIndex}.500Z`,
        userMessage: turnIndex === 0 ? 'Keep the source quote' : '',
        assistantText: turnIndex === 0 ? 'Understood.' : '',
        toolCalls: [],
        cursor: `${turnIndex + 1}|${turnIndex + 1}`,
        surface: 'cli',
        hasExternalContent: false,
        resumeMarkerBefore: false,
        validateSource: () => true,
        ...overrides,
    });
    const manifest = () => {
        const memory = f.db
            .prepare(`SELECT m.id FROM memories m JOIN sessions s ON s.id = m.session_id
            WHERE s.native_id = 'manifest-chat' AND m.turn_index = 1`)
            .get() as { id: number } | undefined;
        return memory && new TaskStateManifestStore(f.db).get(memory.id);
    };
    const issueRequest = (requestId = report.request_id, injectionId = 'hook-request-1') =>
        f.db.transaction(() => {
            const body = taskStateRequestMarker('precompact_manifest', requestId);
            f.store.recordInjection({
                tool: 'claude-code',
                nativeSessionId: 'manifest-chat',
                injectedAt: '2026-09-28T00:00:00.750Z',
                injectionId,
                body,
            });
            return new TaskStateRequestStore(f.db).issue({
                tool: 'claude-code',
                nativeSessionId: 'manifest-chat',
                cwd: projectPath,
                mode: 'precompact_manifest',
                requestId,
                injectionId,
            });
        })();
    return { ...f, daemon, persist, turn, manifest, issueRequest, logs, summarizer };
}

afterEach(() => vi.unstubAllEnvs());

describe('task-state manifest ingestion', () => {
    it('keeps a matching pending request when another ordinary prompt tries to issue a new one', async () => {
        const f = fixture();
        await f.persist(f.turn(0));
        expect(f.issueRequest()).toBe(true);
        expect(f.issueRequest('01J00000000000000000000001', 'hook-request-2')).toBe(false);
        expect(f.db.prepare('SELECT request_id FROM task_state_requests').all()).toEqual([{ request_id: report.request_id }]);
        await f.persist(f.turn(1, { taskStateReport: report }));
        expect(f.manifest()?.coverage.state).toBe('verified');
    });

    it('does not revive a request after revocation and regrant of the same consent root', async () => {
        const f = fixture();
        await f.persist(f.turn(0));
        expect(f.issueRequest()).toBe(true);
        const original = f.db.prepare('SELECT consent_ulid, consent_decided_at FROM task_state_requests').get() as {
            consent_ulid: string;
            consent_decided_at: string;
        };
        f.store.consent.revoke(f.turn(0).projectPath);
        f.store.consent.grant(f.turn(0).projectPath);
        const current = f.store.consent.approvedDecisionForCanonicalPath(f.turn(0).projectPath);
        expect(current?.ulid).toBe(original.consent_ulid);
        expect(current?.decided_at).not.toBe(original.consent_decided_at);
        await f.persist(f.turn(1, { taskStateReport: report }));
        expect(f.manifest()).toBeUndefined();
        expect(f.logs.some((line) => line.includes('no matching unconsumed hook request'))).toBe(true);
    });

    it('withholds a child report with the parent native id but a different source path', async () => {
        const f = fixture();
        await f.persist(f.turn(0));
        expect(f.issueRequest()).toBe(true);
        const childPath = path.join(f.directory, 'child.jsonl');
        await f.persist(f.turn(1, { sourcePath: childPath, taskStateReport: report }), 'sub-agent');
        expect(f.manifest()).toBeUndefined();
        expect(f.logs.some((line) => line.includes('no matching unconsumed hook request'))).toBe(true);
    });

    it('withholds unsolicited, foreign, and reused request ids', async () => {
        const unsolicited = fixture();
        await unsolicited.persist(unsolicited.turn(0));
        await unsolicited.persist(unsolicited.turn(1, { taskStateReport: report }));
        expect(unsolicited.manifest()).toBeUndefined();

        const foreign = fixture();
        await foreign.persist(foreign.turn(0));
        expect(foreign.issueRequest()).toBe(true);
        await foreign.persist(foreign.turn(1, { taskStateReport: { ...report, request_id: '01J00000000000000000000001' } }));
        expect(foreign.manifest()).toBeUndefined();

        const reused = fixture();
        await reused.persist(reused.turn(0));
        expect(reused.issueRequest()).toBe(true);
        await reused.persist(reused.turn(1, { taskStateReport: report }));
        await reused.persist(reused.turn(2, { taskStateReport: report }));
        expect(reused.db.prepare('SELECT COUNT(*) AS count FROM task_state_manifests').get()).toEqual({ count: 1 });
        expect(reused.logs.some((line) => line.includes('no matching unconsumed hook request'))).toBe(true);
    });

    it('withholds a request after checkout identity, consent, or source generation changes', async () => {
        const moved = fixture();
        await moved.persist(moved.turn(0));
        expect(moved.issueRequest()).toBe(true);
        // Model a replaced checkout inode without requiring a filesystem
        // rename, which some test sandboxes prohibit.
        moved.db.prepare("UPDATE task_state_requests SET checkout_ino = 'substituted' WHERE request_id = ?").run(report.request_id);
        await moved.persist(moved.turn(1, { taskStateReport: report }));
        expect(moved.manifest()).toBeUndefined();

        const revoked = fixture();
        await revoked.persist(revoked.turn(0));
        expect(revoked.issueRequest()).toBe(true);
        revoked.store.consent.revoke(revoked.turn(0).projectPath);
        await revoked.persist(revoked.turn(1, { taskStateReport: report }));
        expect(revoked.manifest()).toBeUndefined();

        const substituted = fixture();
        await substituted.persist(substituted.turn(0));
        expect(substituted.issueRequest()).toBe(true);
        substituted.db
            .prepare(`INSERT INTO source_generations (tool, native_id, generation) VALUES (?, ?, 1)
                ON CONFLICT (tool, native_id) DO UPDATE SET generation = generation + 1`)
            .run('claude-code', 'manifest-chat');
        await substituted.persist(substituted.turn(1, { taskStateReport: report }));
        expect(substituted.manifest()).toBeUndefined();
    });

    it('stores a verified report after ordinary source capture, without summarizing a report-only turn or duplicating it', async () => {
        const f = fixture();
        expect(await f.persist(f.turn(0))).toBe(true);
        expect(f.issueRequest()).toBe(true);
        expect(await f.persist(f.turn(1, { taskStateReport: report }))).toBe(true);
        expect(f.manifest()?.coverage, f.logs.join('\n')).toEqual({ state: 'verified', resolvedSourceCount: 1, totalSourceCount: 1 });
        expect(f.summarizer.summarize).toHaveBeenCalledTimes(1);
        expect(await f.persist(f.turn(1, { taskStateReport: report }))).toBe(false);
        expect(f.db.prepare('SELECT COUNT(*) AS count FROM task_state_manifests').get()).toEqual({ count: 1 });
    });

    it('does not create a manifest when Memory-Plus is disabled or the report is from a child session', async () => {
        const disabled = fixture(false);
        await disabled.persist(disabled.turn(0));
        await disabled.persist(disabled.turn(1, { taskStateReport: report }));
        expect(disabled.manifest()).toBeUndefined();
        expect(disabled.logs.some((line) => line.includes('Memory-Plus disabled'))).toBe(true);

        const child = fixture();
        await child.persist(child.turn(0), 'sub-agent');
        expect(child.issueRequest()).toBe(false);
        await child.persist(child.turn(1, { taskStateReport: report }), 'sub-agent');
        expect(child.manifest()).toBeUndefined();
    });

    it('rejects a revoked checkout and a report turn that quotes injected content', async () => {
        const revoked = fixture();
        await revoked.persist(revoked.turn(0));
        revoked.store.consent.revoke(revoked.turn(0).projectPath);
        expect(await revoked.persist(revoked.turn(1, { taskStateReport: report }))).toBe(false);
        expect(revoked.manifest()).toBeUndefined();

        const quoteBack = fixture();
        await quoteBack.persist(quoteBack.turn(0));
        const body = 'The selected architecture keeps transcript capture passive and local across tools.';
        quoteBack.store.recordInjection({
            tool: 'claude-code',
            nativeSessionId: 'manifest-chat',
            injectedAt: '2026-09-28T00:00:00.500Z',
            injectionId: '01J00000000000000000000000',
            body,
        });
        expect(
            await quoteBack.persist(
                quoteBack.turn(1, {
                    userMessage: `Please follow this: ${body}`,
                    taskStateReport: report,
                }),
            ),
        ).toBe(false);
        expect(quoteBack.manifest()).toBeUndefined();
    });

    it('records and logs incomplete source coverage instead of treating it as verified', async () => {
        const f = fixture();
        await f.persist(f.turn(0));
        expect(f.issueRequest()).toBe(true);
        await f.persist(
            f.turn(1, {
                taskStateReport: {
                    ...report,
                    objective: { text: 'Missing source', sources: [{ role: 'user', quote: 'No such quote exists here' }] },
                },
            }),
        );
        expect(f.manifest()).toBeUndefined();
        expect(f.logs.some((line) => line.includes('source coverage incomplete'))).toBe(true);
    });

    it('withdraws a persisted manifest when the native transcript becomes incognito, retaining its memory', async () => {
        const f = fixture();
        await f.persist(f.turn(0));
        expect(f.issueRequest()).toBe(true);
        await f.persist(f.turn(1, { taskStateReport: report }));
        expect(f.manifest()).toBeDefined();
        f.store.recordIncognitoTranscript('claude-code', 'manifest-chat');
        expect(f.manifest()).toBeUndefined();
        expect(f.db.prepare('SELECT COUNT(*) AS count FROM memories').get()).toEqual({ count: 2 });
    });

    it('withdraws a report manifest when its memory is reingested', async () => {
        const f = fixture();
        await f.persist(f.turn(0));
        expect(f.issueRequest()).toBe(true);
        await f.persist(f.turn(1, { taskStateReport: report }));
        expect(f.manifest()).toBeDefined();
        const session = f.store.findSession('claude-code', 'manifest-chat')!;
        expect(
            f.store.reingestTurn(
                f.turn(1, { taskStateReport: report }),
                session.id,
                session.project_id,
                { decisions: [], pending_items: [], status: 'ok' },
                true,
            ),
        ).toBe(true);
        expect(f.manifest()).toBeUndefined();
    });
});
