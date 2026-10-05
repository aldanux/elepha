import { mkdirSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DURABLE_CAPTURE_FILTER_VERSION } from '../../src/config/constants.js';
import * as providerTranscript from '../../src/security/provider-transcript.js';
import { SessionReader } from '../../src/serving/session-reader.js';
import type { ParsedTurn } from '../../src/types/index.js';
import { createTestDb, seedConsentRoot, seedProject, seedSession } from '../helpers/db.js';

const SUMMARY = { decisions: [], pending_items: [], status: 'not_configured' as const };

function durableFixture(options: { durable?: boolean; sourceOnDisk?: boolean } = {}) {
    const f = createTestDb('indexed-turn-durable-');
    const cwd = path.join(f.directory, 'checkout');
    mkdirSync(cwd);
    const project = seedProject(f, { path: cwd });
    seedConsentRoot(f, { path: cwd });
    const sourcePath = path.join(f.directory, options.sourceOnDisk ? 'rollout.jsonl' : 'missing.jsonl');
    if (options.sourceOnDisk) {
        writeFileSync(sourcePath, `${JSON.stringify({ type: 'session_meta', payload: { id: 'native', cwd } })}\n`);
    }
    const session = seedSession(f, { project, nativeId: 'native', sourcePath });
    const parsed: ParsedTurn = {
        tool: 'codex',
        sessionId: 'native',
        sourcePath,
        projectPath: cwd,
        turnIndex: 0,
        startedAt: '2026-09-27T00:00:00.000Z',
        endedAt: '2026-09-27T00:00:01.000Z',
        userMessage: 'Keep signed receipts for refunds',
        assistantText: 'Agreed; receipts remain.',
        toolCalls: [],
        cursor: '100:1:abc',
        hasExternalContent: false,
        resumeMarkerBefore: false,
    };
    expect(f.store.recordTurn(parsed, session.id, project.id, SUMMARY, options.durable ?? true)).toBe(true);
    return { ...f, cwd, project, session, parsed };
}

// Observe the actual authenticated provider-content opening boundary.
function spyOnProviderRead() {
    return vi.spyOn(providerTranscript, 'openProviderTranscript');
}

afterEach(() => {
    vi.restoreAllMocks();
});

describe('indexed exact-turn evidence', () => {
    it('serves a complete matching durable row when its source is gone', async () => {
        const f = durableFixture();
        const request = { ...f.session, expectedProjectPath: f.cwd };
        const providerRead = spyOnProviderRead();
        const result = await new SessionReader(f.db).indexedTurnEvidence(request, 0);
        expect(providerRead).not.toHaveBeenCalled();
        expect(result).toMatchObject({
            state: 'available',
            source: 'durable',
            turnIndex: 0,
            projection: { userPrompt: 'Keep signed receipts for refunds', assistantResponse: 'Agreed; receipts remain.' },
        });
        f.store.consent.revoke(f.cwd);
        expect(await new SessionReader(f.db).indexedTurnEvidence(request, 0)).toEqual({
            state: 'unavailable',
            reason: 'checkout_not_consented',
        });
        seedConsentRoot(f, { path: f.cwd });
        expect(await new SessionReader(f.db).indexedTurnEvidence({ ...request, source_path: 'other.jsonl' }, 0)).toEqual({
            state: 'unavailable',
            reason: 'indexed_turn_unavailable',
        });
        expect(await new SessionReader(f.db).indexedTurnEvidence(request, 0, AbortSignal.abort())).toEqual({
            state: 'unavailable',
            reason: 'deadline',
        });
    });

    it('never serves an older durable copy after the indexed turn is reingested', async () => {
        const f = durableFixture();
        const request = { ...f.session, expectedProjectPath: f.cwd };
        const reader = new SessionReader(f.db);
        expect((await reader.indexedTurnEvidence(request, 0)).state).toBe('available');

        expect(
            f.store.reingestTurn(
                { ...f.parsed, userMessage: 'Keep a fresh refund ledger', assistantText: 'Agreed; ledger replaces receipts.' },
                f.session.id,
                f.project.id,
                SUMMARY,
            ),
        ).toBe(true);
        expect(await reader.indexedTurnEvidence(request, 0)).toEqual({ state: 'unavailable', reason: 'indexed_turn_evidence_stale' });
    });

    // A per-turn read no longer falls back to the provider transcript: without a
    // stored filtered copy the turn is a coverage gap even while the source exists.
    it('reports a turn without stored evidence as unavailable without reading the existing transcript', async () => {
        const f = durableFixture({ durable: false, sourceOnDisk: true });
        const providerRead = spyOnProviderRead();
        expect(await new SessionReader(f.db).indexedTurnEvidence({ ...f.session, expectedProjectPath: f.cwd }, 0)).toEqual({
            state: 'unavailable',
            reason: 'indexed_turn_evidence_missing',
        });
        expect(providerRead).not.toHaveBeenCalled();
    });

    it.each([
        ['excluded from the index', "UPDATE turn_search_index SET coverage = 'excluded'", 'indexed_turn_filtered'],
        ['excluded by the stored filter', 'UPDATE filtered_turns SET included = 0', 'indexed_turn_filtered'],
        ['truncated at the older end', 'UPDATE filtered_turns SET omitted_before_chars = 12', 'indexed_turn_evidence_truncated'],
        [
            'captured as truncated',
            "UPDATE durable_capture_status SET state = 'complete_truncated'",
            'indexed_turn_evidence_complete_truncated',
        ],
        [
            'captured under an older filter',
            'UPDATE filtered_turns SET filter_version = filter_version - 1',
            'indexed_turn_evidence_filter_version_mismatch',
        ],
        ['evicted', "UPDATE durable_capture_status SET state = 'evicted'; DELETE FROM filtered_turns", 'indexed_turn_evidence_evicted'],
        ['removed without an eviction status', 'DELETE FROM filtered_turns', 'indexed_turn_evidence_missing'],
    ])('does not serve evidence %s, even with the transcript on disk', async (_label, mutation, reason) => {
        const f = durableFixture({ sourceOnDisk: true });
        f.db.exec(mutation);
        const providerRead = spyOnProviderRead();
        expect(await new SessionReader(f.db).indexedTurnEvidence({ ...f.session, expectedProjectPath: f.cwd }, 0)).toEqual({
            state: 'unavailable',
            reason,
        });
        expect(providerRead).not.toHaveBeenCalled();
    });

    it('blocks stored evidence once the checkout path resolves to a different directory', async () => {
        const f = durableFixture();
        const request = { ...f.session, expectedProjectPath: f.cwd };
        expect((await new SessionReader(f.db).indexedTurnEvidence(request, 0)).state).toBe('available');
        const elsewhere = path.join(f.directory, 'elsewhere');
        renameSync(f.cwd, elsewhere);
        symlinkSync(elsewhere, f.cwd, 'dir');
        expect(await new SessionReader(f.db).indexedTurnEvidence(request, 0)).toEqual({
            state: 'unavailable',
            reason: 'checkout_not_consented',
        });
    });

    it('rejects stale index versions and self-injected durable text', async () => {
        const f = durableFixture();
        const request = { ...f.session, expectedProjectPath: f.cwd };
        f.db.prepare('UPDATE turn_search_index SET filter_version = ?').run(DURABLE_CAPTURE_FILTER_VERSION - 1);
        expect(await new SessionReader(f.db).indexedTurnEvidence(request, 0)).toEqual({
            state: 'unavailable',
            reason: 'indexed_turn_filter_version_mismatch',
        });
        f.db.prepare('UPDATE turn_search_index SET filter_version = ?').run(DURABLE_CAPTURE_FILTER_VERSION);
        f.db.prepare('UPDATE filtered_turns SET user_prompt = ?').run('[[elepha:notify:01KABCDEFGHIJKLMNPQRSTUVWX]]');
        expect((await new SessionReader(f.db).indexedTurnEvidence(request, 0)).state).toBe('unavailable');
    });
});
