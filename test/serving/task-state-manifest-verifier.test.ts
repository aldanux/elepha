import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DURABLE_CAPTURE_FILTER_VERSION, TASK_STATE_MANIFEST_MAX_SOURCE_TURNS } from '../../src/config/constants.js';
import { escapeShellSyntax } from '../../src/security/sanitize.js';
import { SessionReader } from '../../src/serving/session-reader.js';
import { manifestSourcesStillCurrent, verifyTaskStateManifest } from '../../src/serving/task-state-manifest-verifier.js';
import { TASK_STATE_MANIFEST_PROJECTION_ENCODING, TaskStateManifestStore } from '../../src/storage/task-state-manifest-store.js';
import type { TaskStateReportInput } from '../../src/types/index.js';
import { createTestDb, seedConsentRoot, seedMemory, seedProject, seedSession } from '../helpers/db.js';

type Report = Extract<TaskStateReportInput, { mode: 'precompact_manifest' }>;

function report(role: 'user' | 'assistant', quote: string): Report {
    return {
        mode: 'precompact_manifest',
        request_id: '01J00000000000000000000000',
        objective: { text: 'Keep the decision', sources: [{ role, quote }] },
        decisions: [],
        constraints: [],
        pending_items: [],
    };
}

function fixture() {
    const f = createTestDb('task-state-verifier-');
    const checkout = path.join(f.directory, 'checkout');
    mkdirSync(checkout);
    const project = seedProject(f, { path: checkout });
    seedConsentRoot(f, { path: checkout });
    const session = seedSession(f, { project, nativeId: 'primary', kind: 'main' });
    return { ...f, checkout, project, session };
}

function turn(
    f: ReturnType<typeof fixture>,
    session: ReturnType<typeof seedSession>,
    project: ReturnType<typeof seedProject>,
    turnIndex: number,
    user: string,
    assistant: string,
    complete = true,
) {
    return seedMemory(f, { project, session, turnIndex, userMessage: user, assistantText: assistant, durableCapture: complete });
}

describe('precompact task-state source verification', () => {
    it('locates shell syntax quotes in the escaped durable projection and persists reproducible offsets', async () => {
        const f = fixture();
        const raw = 'Prelude `setup` then keep `history` and $(date)';
        const quote = 'keep `history` and $(date)';
        const earlier = turn(f, f.session, f.project, 0, raw, 'Reply');
        const reporting = turn(f, f.session, f.project, 1, 'Report now', 'Acknowledged');
        f.db.prepare('UPDATE filtered_turns SET user_prompt = ? WHERE memory_id = ?').run(escapeShellSyntax(raw), earlier.id);

        const result = await verifyTaskStateManifest(f.db, {
            reportingMemoryId: reporting.id,
            report: report('user', quote),
            cwd: f.checkout,
        });
        expect(result.state).toBe('prepared');
        if (result.state !== 'prepared') return;
        expect(result.manifest.coverage.state).toBe('verified');
        const locator = result.manifest.sourceLocators[0];
        expect(locator).toMatchObject({
            sourceMemoryId: earlier.id,
            projectionEncoding: TASK_STATE_MANIFEST_PROJECTION_ENCODING,
            evidenceSource: 'durable',
        });
        const stored = new TaskStateManifestStore(f.db);
        expect(stored.insert(result.manifest)).toBe('inserted');
        const persisted = stored.get(reporting.id);
        expect(persisted?.report.objective?.sources[0]?.quote).toBe(escapeShellSyntax(quote));
        expect(escapeShellSyntax(raw).slice(locator?.start, locator?.end)).toBe(persisted?.report.objective?.sources[0]?.quote);
    });

    it('locates raw transcript quotes after earlier escaped syntax and control characters', async () => {
        const f = fixture();
        const raw = 'Prelude `setup`\u001b[31m then keep `history` and $(date)';
        const quote = 'keep `history` and $(date)';
        const earlier = turn(f, f.session, f.project, 0, raw, 'Reply');
        const reporting = turn(f, f.session, f.project, 1, 'Report now', 'Acknowledged');
        const durable = new SessionReader(f.db);
        const reader: Pick<SessionReader, 'indexedTurnEvidence'> = {
            indexedTurnEvidence: async (...args) =>
                args[1] === earlier.turn_index
                    ? {
                          state: 'available',
                          turnIndex: earlier.turn_index,
                          projection: {
                              filterVersion: DURABLE_CAPTURE_FILTER_VERSION,
                              included: true,
                              userPrompt: raw,
                              assistantResponse: 'Reply',
                              toolCalls: [],
                              omittedToolCallCount: 0,
                          },
                          source: 'transcript',
                      }
                    : durable.indexedTurnEvidence(...args),
        };
        const result = await verifyTaskStateManifest(
            f.db,
            { reportingMemoryId: reporting.id, report: report('user', quote), cwd: f.checkout },
            reader,
        );
        expect(result.state).toBe('prepared');
        if (result.state !== 'prepared') return;
        expect(result.manifest.coverage.state).toBe('verified');
        const locator = result.manifest.sourceLocators[0];
        expect(locator).toMatchObject({
            sourceMemoryId: earlier.id,
            projectionEncoding: TASK_STATE_MANIFEST_PROJECTION_ENCODING,
            evidenceSource: 'transcript',
        });
        const stored = new TaskStateManifestStore(f.db);
        expect(stored.insert(result.manifest)).toBe('inserted');
        expect(escapeShellSyntax(raw).slice(locator?.start, locator?.end)).toBe(
            stored.get(reporting.id)?.report.objective?.sources[0]?.quote,
        );
    });

    it('proves exact role-specific quotes and permits the reporting user prompt only', async () => {
        const f = fixture();
        const earlier = turn(f, f.session, f.project, 0, 'User asks for café receipts', 'Assistant agrees about receipts');
        const reporting = turn(f, f.session, f.project, 1, 'Report café receipts now', 'Assistant agrees about receipts');
        const found = await verifyTaskStateManifest(f.db, {
            reportingMemoryId: reporting.id,
            report: report('assistant', 'Assistant agrees about receipts'),
            cwd: f.checkout,
        });
        expect(found.state).toBe('prepared');
        if (found.state !== 'prepared') return;
        expect(found.manifest.coverage).toEqual({ state: 'verified', resolvedSourceCount: 1, totalSourceCount: 1 });
        expect(found.manifest.sourceLocators[0]).toMatchObject({
            sourceMemoryId: earlier.id,
            sourceTurnIndex: 0,
            role: 'assistant',
            start: 0,
            end: 31,
        });

        const currentUser = await verifyTaskStateManifest(f.db, {
            reportingMemoryId: reporting.id,
            report: report('user', 'café receipts now'),
            cwd: f.checkout,
        });
        expect(currentUser.state).toBe('prepared');
        if (currentUser.state === 'prepared') {
            expect(currentUser.manifest.sourceLocators[0]).toMatchObject({ sourceMemoryId: reporting.id, role: 'user' });
        }
        const wrongRole = await verifyTaskStateManifest(f.db, {
            reportingMemoryId: reporting.id,
            report: report('user', 'Assistant agrees about receipts'),
            cwd: f.checkout,
        });
        expect(wrongRole.state === 'prepared' && wrongRole.manifest.coverage.state).toBe('incomplete');
    });

    it('excludes adjacent native chats and other physical checkouts', async () => {
        const f = fixture();
        const otherChat = seedSession(f, { project: f.project, nativeId: 'other-chat', kind: 'main' });
        turn(f, otherChat, f.project, 0, 'Secret other-chat quote', 'Other assistant quote');
        const checkout2 = path.join(f.directory, 'other-checkout');
        mkdirSync(checkout2);
        const project2 = seedProject(f, { path: checkout2 });
        seedConsentRoot(f, { path: checkout2 });
        const otherCheckout = seedSession(f, { project: project2, nativeId: 'other-checkout', kind: 'main' });
        f.db.prepare('UPDATE sessions SET segment_index = 1 WHERE id = ?').run(f.session.id);
        f.db.prepare("UPDATE sessions SET native_id = 'primary' WHERE id = ?").run(otherCheckout.id);
        turn(f, otherCheckout, project2, 0, 'Secret other-checkout quote', 'Other checkout reply');
        const reporting = turn(f, f.session, f.project, 1, 'Report now', 'Acknowledged');
        for (const quote of ['Secret other-chat quote', 'Secret other-checkout quote']) {
            const result = await verifyTaskStateManifest(f.db, {
                reportingMemoryId: reporting.id,
                report: report('user', quote),
                cwd: f.checkout,
            });
            expect(result.state === 'prepared' && result.manifest.coverage).toMatchObject({ state: 'incomplete' });
        }
    });

    it('reports unavailable or truncated source without accepting a quote', async () => {
        const f = fixture();
        const missing = turn(f, f.session, f.project, 0, 'Original source sentence', 'Reply', false);
        const reporting = turn(f, f.session, f.project, 1, 'Report now', 'Acknowledged');
        const result = await verifyTaskStateManifest(f.db, {
            reportingMemoryId: reporting.id,
            report: report('user', 'Original source sentence'),
            cwd: f.checkout,
        });
        expect(result.state === 'prepared' && result.manifest.coverage).toMatchObject({
            state: 'incomplete',
            resolvedSourceCount: 0,
            totalSourceCount: 1,
        });
        f.db.prepare('UPDATE filtered_turns SET omitted_before_chars = 10 WHERE memory_id = ?').run(reporting.id);
        expect(missing.id).toBeGreaterThan(0);
        const truncated = await verifyTaskStateManifest(f.db, {
            reportingMemoryId: reporting.id,
            report: report('user', 'Report now'),
            cwd: f.checkout,
        });
        expect(truncated.state === 'prepared' && truncated.manifest.coverage).toMatchObject({ state: 'incomplete' });
    });

    it('rechecks consent after awaited evidence and excludes child sessions', async () => {
        const f = fixture();
        const child = seedSession(f, { project: f.project, nativeId: 'child', kind: 'subagent' });
        f.db.prepare('UPDATE sessions SET segment_index = 2 WHERE id = ?').run(f.session.id);
        f.db.prepare("UPDATE sessions SET native_id = 'primary', segment_index = 1 WHERE id = ?").run(child.id);
        turn(f, child, f.project, 0, 'Child-only instruction', 'Child reply');
        turn(f, f.session, f.project, 0, 'Prior exact instruction', 'Prior reply');
        const reporting = turn(f, f.session, f.project, 1, 'Report now', 'Acknowledged');
        const excluded = await verifyTaskStateManifest(f.db, {
            reportingMemoryId: reporting.id,
            report: report('user', 'Child-only instruction'),
            cwd: f.checkout,
        });
        expect(excluded.state === 'prepared' && excluded.manifest.coverage).toMatchObject({ state: 'incomplete' });

        const underlying = new SessionReader(f.db);
        const reader: Pick<SessionReader, 'indexedTurnEvidence'> = {
            indexedTurnEvidence: async (...args) => {
                const evidence = await underlying.indexedTurnEvidence(...args);
                f.store.consent.revoke(f.checkout);
                return evidence;
            },
        };
        const revoked = await verifyTaskStateManifest(
            f.db,
            {
                reportingMemoryId: reporting.id,
                report: report('user', 'Prior exact instruction'),
                cwd: f.checkout,
            },
            reader,
        );
        expect(revoked).toEqual({ state: 'unavailable', reason: 'checkout_authorization_changed' });
    });

    it('bounds the source scan and marks unresolved quotes as partial coverage', async () => {
        const f = fixture();
        for (let index = 0; index < TASK_STATE_MANIFEST_MAX_SOURCE_TURNS + 2; index++) {
            turn(f, f.session, f.project, index, `Turn ${index}`, `Reply ${index}`);
        }
        const reporting = f.store.listMemoriesForSession(f.session.id).at(-1);
        if (!reporting) throw new Error('Missing reporting turn');
        const result = await verifyTaskStateManifest(f.db, {
            reportingMemoryId: reporting.id,
            report: report('user', 'Turn 0'),
            cwd: f.checkout,
        });
        expect(result.state === 'prepared' && result.manifest.coverage).toMatchObject({
            state: 'incomplete',
            reason: 'older_sources_not_scanned',
        });
    });

    it('marks reports with no citations incomplete and rejects unclassified reporting sessions', async () => {
        const f = fixture();
        const reporting = turn(f, f.session, f.project, 0, 'Report now', 'Acknowledged');
        const empty: Report = {
            mode: 'precompact_manifest',
            request_id: '01J00000000000000000000000',
            objective: null,
            decisions: [],
            constraints: [],
            pending_items: [],
        };
        const result = await verifyTaskStateManifest(f.db, {
            reportingMemoryId: reporting.id,
            report: empty,
            cwd: f.checkout,
        });
        expect(result.state === 'prepared' && result.manifest.coverage).toEqual({
            state: 'incomplete',
            resolvedSourceCount: 0,
            totalSourceCount: 0,
            reason: 'no_source_backed_items',
        });
        f.db.prepare('UPDATE sessions SET kind = NULL WHERE id = ?').run(f.session.id);
        expect(
            await verifyTaskStateManifest(f.db, {
                reportingMemoryId: reporting.id,
                report: report('user', 'Report now'),
                cwd: f.checkout,
            }),
        ).toEqual({ state: 'unavailable', reason: 'reporting_turn_unavailable' });
    });

    it('provides a synchronous current-source check for the final write transaction', async () => {
        const f = fixture();
        turn(f, f.session, f.project, 0, 'Prior exact instruction', 'Prior reply');
        const reporting = turn(f, f.session, f.project, 1, 'Report now', 'Acknowledged');
        const result = await verifyTaskStateManifest(f.db, {
            reportingMemoryId: reporting.id,
            report: report('user', 'Prior exact instruction'),
            cwd: f.checkout,
        });
        expect(result.state).toBe('prepared');
        if (result.state !== 'prepared') return;
        expect(manifestSourcesStillCurrent(f.db, result.manifest, result.checkpoint)).toBe(true);
        f.db
            .prepare(
                "INSERT INTO source_generations (tool, native_id, generation) VALUES ('codex', 'primary', 1) ON CONFLICT (tool, native_id) DO UPDATE SET generation = 1",
            )
            .run();
        expect(manifestSourcesStillCurrent(f.db, result.manifest, result.checkpoint)).toBe(false);
    });

    it('rejects source-path and project-path substitution after async proof', async () => {
        const f = fixture();
        turn(f, f.session, f.project, 0, 'Prior exact instruction', 'Prior reply');
        const reporting = turn(f, f.session, f.project, 1, 'Report now', 'Acknowledged');
        const result = await verifyTaskStateManifest(f.db, {
            reportingMemoryId: reporting.id,
            report: report('user', 'Prior exact instruction'),
            cwd: f.checkout,
        });
        expect(result.state).toBe('prepared');
        if (result.state !== 'prepared') return;
        const current = () => manifestSourcesStillCurrent(f.db, result.manifest, result.checkpoint);
        expect(current()).toBe(true);
        f.db.prepare('UPDATE sessions SET source_path = ? WHERE id = ?').run('substituted.jsonl', f.session.id);
        expect(current()).toBe(false);
        f.db.prepare('UPDATE sessions SET source_path = ? WHERE id = ?').run(f.session.source_path, f.session.id);
        expect(current()).toBe(true);
        const otherPath = path.join(f.directory, 'substituted-checkout');
        f.db.prepare('UPDATE projects SET path = ? WHERE id = ?').run(otherPath, f.project.id);
        expect(current()).toBe(false);
    });
});
