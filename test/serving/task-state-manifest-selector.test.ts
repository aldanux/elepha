import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { claudeProjectsRoot } from '../../src/config/paths.js';
import { setSetting } from '../../src/config/settings.js';
import { SessionReader } from '../../src/serving/session-reader.js';
import {
    CLAUDE_HISTORICAL_CHECKPOINT_VERSION,
    selectFreshClaudePrecompactManifest,
    selectHistoricalClaudePrecompactCheckpoint,
} from '../../src/serving/task-state-manifest-selector.js';
import { verifyTaskStateManifest } from '../../src/serving/task-state-manifest-verifier.js';
import { TaskStateManifestStore } from '../../src/storage/task-state-manifest-store.js';
import { createTestDb, seedMemory, seedProject, seedSession } from '../helpers/db.js';

const boundary = { type: 'system', subtype: 'compact_boundary' };
const summary = { type: 'user', isCompactSummary: true, message: { role: 'user', content: 'Native summary' } };
const line = (value: unknown) => `${JSON.stringify(value)}\n`;

function fixture() {
    const f = createTestDb('task-state-selector-');
    vi.stubEnv('ELEPHA_HOME', f.directory);
    vi.stubEnv('CLAUDE_CONFIG_DIR', path.join(f.directory, '.claude'));
    setSetting('memory-plus', 'true');
    const checkout = path.join(f.directory, 'checkout');
    mkdirSync(checkout);
    f.store.consent.grant(checkout);
    const providerDirectory = path.join(claudeProjectsRoot(), 'checkout');
    mkdirSync(providerDirectory, { recursive: true });
    const transcriptPath = path.join(providerDirectory, 'native-chat.jsonl');
    const source = line({ type: 'user', message: { role: 'user', content: 'Keep this decision' } });
    const report = line({ type: 'user', message: { role: 'user', content: 'Report task state' } });
    const metadata =
        line({ type: 'system', subtype: 'turn_duration' }) +
        line({ type: 'mode' }) +
        line({ type: 'user', isMeta: true, message: { role: 'user', content: '<command-name>/compact</command-name>' } }) +
        line({ type: 'user', userType: 'external', message: { role: 'user', content: '/compact' } });
    const boundaryLine = line(boundary);
    writeFileSync(transcriptPath, source + report + metadata + boundaryLine + line(summary));
    const project = seedProject(f, { path: checkout });
    const session = seedSession(f, { project, tool: 'claude-code', nativeId: 'native-chat', sourcePath: transcriptPath, kind: 'main' });
    const sourceTurn = seedMemory(f, {
        project,
        session,
        turnIndex: 0,
        userMessage: 'Keep this decision',
        assistantText: 'Agreed',
        cursor: `${Buffer.byteLength(source)}|1|abc`,
        durableCapture: true,
    });
    const reporting = seedMemory(f, {
        project,
        session,
        turnIndex: 1,
        userMessage: 'Report task state',
        assistantText: '',
        cursor: `${Buffer.byteLength(source + report)}|2|abc`,
        durableCapture: true,
    });
    const input = { nativeSessionId: 'native-chat', cwd: checkout, transcriptPath };
    return { ...f, checkout, transcriptPath, project, session, sourceTurn, reporting, source, report, metadata, boundaryLine, input };
}

async function storeManifest(f: ReturnType<typeof fixture>): Promise<void> {
    const prepared = await verifyTaskStateManifest(f.db, {
        reportingMemoryId: f.reporting.id,
        report: {
            mode: 'precompact_manifest',
            request_id: '01J00000000000000000000000',
            objective: { text: 'Keep this decision', sources: [{ role: 'user', quote: 'Keep this decision' }] },
            decisions: [],
            constraints: [],
            pending_items: [],
        },
        cwd: f.checkout,
    });
    expect(prepared.state).toBe('prepared');
    if (prepared.state !== 'prepared') return;
    expect(prepared.manifest.coverage.state).toBe('verified');
    new TaskStateManifestStore(f.db).insert(prepared.manifest);
}

afterEach(() => vi.unstubAllEnvs());

describe('Claude precompact manifest selection', () => {
    it('selects the verified report for the latest native compact in the exact root checkout', async () => {
        const f = fixture();
        await storeManifest(f);
        const result = await selectFreshClaudePrecompactManifest(f.db, f.input);
        expect(result, JSON.stringify(result)).toMatchObject({ state: 'available' });
        if (result.state === 'available') expect(result.manifest.memoryId).toBe(f.reporting.id);
    });

    it('does not cap away a fresh report when postcompact history grows', async () => {
        const f = fixture();
        await storeManifest(f);
        const postcompactOffset = Buffer.byteLength(f.source + f.report + f.metadata + f.boundaryLine + line(summary));
        for (let index = 2; index < 70; index++) {
            seedMemory(f, {
                project: f.project,
                session: f.session,
                turnIndex: index,
                userMessage: `Postcompact turn ${index}`,
                cursor: `${postcompactOffset + index}|${index + 1}|abc`,
                durableCapture: true,
            });
        }
        const result = await selectFreshClaudePrecompactManifest(f.db, f.input);
        expect(result.state, JSON.stringify(result)).toBe('available');
    });

    it('abstains after an intervening captured turn or a newer compact', async () => {
        const f = fixture();
        await storeManifest(f);
        const intervening = line({ type: 'user', message: { role: 'user', content: 'Changed task' } });
        writeFileSync(f.transcriptPath, f.source + f.report + f.metadata + intervening + f.boundaryLine + line(summary));
        expect(await selectFreshClaudePrecompactManifest(f.db, f.input)).toEqual({
            state: 'unavailable',
            reason: 'intervening_source_record',
        });
        seedMemory(f, {
            project: f.project,
            session: f.session,
            turnIndex: 2,
            userMessage: 'Changed task',
            cursor: `${Buffer.byteLength(f.source + f.report + f.metadata + intervening)}|3|abc`,
        });
        expect(await selectFreshClaudePrecompactManifest(f.db, f.input)).toEqual({
            state: 'unavailable',
            reason: 'intervening_source_record',
        });

        writeFileSync(f.transcriptPath, f.source + f.report + f.metadata + f.boundaryLine + line(summary) + f.boundaryLine + line(summary));
        expect(await selectFreshClaudePrecompactManifest(f.db, f.input)).toEqual({
            state: 'unavailable',
            reason: 'manifest_not_for_latest_compact',
        });
    });

    it('abstains on an unknown system record before the compact boundary', async () => {
        const f = fixture();
        await storeManifest(f);
        const unknown = line({ type: 'system', subtype: 'new_task_state', text: 'Change the pending task' });
        writeFileSync(f.transcriptPath, f.source + f.report + unknown + f.metadata + f.boundaryLine + line(summary));
        expect(await selectFreshClaudePrecompactManifest(f.db, f.input)).toEqual({
            state: 'unavailable',
            reason: 'intervening_source_record',
        });
    });

    it('does not treat human text starting with a command wrapper as metadata', async () => {
        const f = fixture();
        await storeManifest(f);
        const human = line({
            type: 'user',
            message: { role: 'user', content: '<command-name>/compact</command-name> Keep working on the changed task' },
        });
        writeFileSync(f.transcriptPath, f.source + f.report + human + f.metadata + f.boundaryLine + line(summary));
        expect(await selectFreshClaudePrecompactManifest(f.db, f.input)).toEqual({
            state: 'unavailable',
            reason: 'intervening_source_record',
        });
    });

    it('abstains for source drift, revoked consent, wrong checkout, child session and incomplete coverage', async () => {
        const f = fixture();
        await storeManifest(f);
        const original = f.db.prepare('SELECT source_digest AS digest FROM turn_search_index WHERE memory_id = ?').get(f.sourceTurn.id) as {
            digest: string;
        };
        f.db.prepare('UPDATE turn_search_index SET source_digest = ? WHERE memory_id = ?').run('a'.repeat(64), f.sourceTurn.id);
        expect(await selectFreshClaudePrecompactManifest(f.db, f.input)).toEqual({
            state: 'unavailable',
            reason: 'source_locator_changed',
        });
        f.db.prepare('UPDATE turn_search_index SET source_digest = ? WHERE memory_id = ?').run(original.digest, f.sourceTurn.id);
        f.store.consent.revoke(f.checkout);
        expect(await selectFreshClaudePrecompactManifest(f.db, f.input)).toEqual({
            state: 'unavailable',
            reason: 'checkout_not_consented',
        });
        f.store.consent.grant(f.checkout);
        const otherCheckout = path.join(f.directory, 'other-checkout');
        mkdirSync(otherCheckout);
        f.store.consent.grant(otherCheckout);
        expect(await selectFreshClaudePrecompactManifest(f.db, { ...f.input, cwd: otherCheckout })).toEqual({
            state: 'unavailable',
            reason: 'captured_scope_ambiguous',
        });
        f.db.prepare("UPDATE sessions SET kind = 'subagent' WHERE id = ?").run(f.session.id);
        expect(await selectFreshClaudePrecompactManifest(f.db, f.input)).toEqual({
            state: 'unavailable',
            reason: 'captured_scope_ambiguous',
        });
        f.db.prepare("UPDATE sessions SET kind = 'main' WHERE id = ?").run(f.session.id);
        f.db
            .prepare("UPDATE task_state_manifests SET coverage_state = 'incomplete', coverage_reason = 'gap' WHERE memory_id = ?")
            .run(f.reporting.id);
        expect(await selectFreshClaudePrecompactManifest(f.db, f.input)).toEqual({ state: 'unavailable', reason: 'manifest_incomplete' });
    });
});

describe('Claude historical precompact checkpoint', () => {
    it('labels a no-gap checkpoint as historical with unknown source coverage beyond the index', async () => {
        const f = fixture();
        await storeManifest(f);
        const result = await selectHistoricalClaudePrecompactCheckpoint(f.db, f.input);
        expect(result, JSON.stringify(result)).toMatchObject({
            state: 'available',
            checkpoint: {
                version: CLAUDE_HISTORICAL_CHECKPOINT_VERSION,
                kind: 'historical_precompact',
                asOfTurnIndex: 1,
                latestIndexedTurn: { segmentIndex: 0, turnIndex: 1 },
                indexedUnreviewedTail: { observedTurnCountAtLeast: 0, truncated: false, sourceBeyondIndex: 'unknown' },
            },
        });
    });

    it('retains the historical checkpoint after a long indexed gap and reports a bounded unreviewed tail', async () => {
        const f = fixture();
        await storeManifest(f);
        for (let index = 2; index < 70; index++) {
            seedMemory(f, {
                project: f.project,
                session: f.session,
                turnIndex: index,
                userMessage: `Later task change ${index}`,
                assistantText: `Later answer ${index}`,
                durableCapture: true,
            });
        }
        const result = await selectHistoricalClaudePrecompactCheckpoint(f.db, f.input);
        expect(result, JSON.stringify(result)).toMatchObject({
            state: 'available',
            checkpoint: {
                asOfTurnIndex: 1,
                latestIndexedTurn: { segmentIndex: 0, turnIndex: 69 },
                indexedUnreviewedTail: { observedTurnCountAtLeast: 64, truncated: true, sourceBeyondIndex: 'unknown' },
            },
        });
    });

    it('abstains for changed source metadata, revoked consent, another checkout, and a child session', async () => {
        const f = fixture();
        await storeManifest(f);
        const digest = (
            f.db.prepare('SELECT source_digest FROM turn_search_index WHERE memory_id = ?').get(f.sourceTurn.id) as {
                source_digest: string;
            }
        ).source_digest;
        f.db.prepare('UPDATE turn_search_index SET source_digest = ? WHERE memory_id = ?').run('a'.repeat(64), f.sourceTurn.id);
        expect(await selectHistoricalClaudePrecompactCheckpoint(f.db, f.input)).toEqual({
            state: 'unavailable',
            reason: 'source_locator_changed',
        });
        f.db.prepare('UPDATE turn_search_index SET source_digest = ? WHERE memory_id = ?').run(digest, f.sourceTurn.id);
        f.store.consent.revoke(f.checkout);
        expect(await selectHistoricalClaudePrecompactCheckpoint(f.db, f.input)).toEqual({
            state: 'unavailable',
            reason: 'checkout_not_consented',
        });
        f.store.consent.grant(f.checkout);
        const sibling = path.join(f.directory, 'sibling-checkout');
        mkdirSync(sibling);
        f.store.consent.grant(sibling);
        expect(await selectHistoricalClaudePrecompactCheckpoint(f.db, { ...f.input, cwd: sibling })).toEqual({
            state: 'unavailable',
            reason: 'captured_scope_ambiguous',
        });
        f.db.prepare("UPDATE sessions SET kind = 'subagent' WHERE id = ?").run(f.session.id);
        expect(await selectHistoricalClaudePrecompactCheckpoint(f.db, f.input)).toEqual({
            state: 'unavailable',
            reason: 'captured_scope_ambiguous',
        });
    });

    it('rechecks consent after an awaited evidence read and rejects a sibling native chat', async () => {
        const f = fixture();
        await storeManifest(f);
        expect(await selectHistoricalClaudePrecompactCheckpoint(f.db, { ...f.input, nativeSessionId: 'sibling-chat' })).toEqual({
            state: 'unavailable',
            reason: 'transcript_identity_mismatch',
        });
        const reader = new SessionReader(f.db);
        const read = reader.indexedTurnEvidence.bind(reader);
        vi.spyOn(reader, 'indexedTurnEvidence').mockImplementation(async (...args) => {
            const evidence = await read(...args);
            f.store.consent.revoke(f.checkout);
            return evidence;
        });
        expect((await selectHistoricalClaudePrecompactCheckpoint(f.db, f.input, reader)).state).toBe('unavailable');
    });
});
