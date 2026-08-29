import { mkdirSync, symlinkSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../../src/storage/db.js';
import { MemoryStore } from '../../src/storage/memory-store.js';
import type { ParsedTurn } from '../../src/types/index.js';
import { withGrantableTestDir } from '../helpers/tmp.js';

function makeTurn(overrides: Partial<ParsedTurn> = {}): ParsedTurn {
    return {
        tool: 'codex',
        sessionId: 'purged-after-early-gate',
        sourcePath: '/tmp/purged-after-early-gate.jsonl',
        projectPath: '/Users/test/purged-after-early-gate',
        turnIndex: 0,
        startedAt: '2026-08-24T00:00:00.000Z',
        endedAt: '2026-08-24T00:00:01.000Z',
        userMessage: 'remember this',
        assistantText: 'do not retain it once purged',
        toolCalls: [],
        cursor: '100|1',
        hasExternalContent: false,
        resumeMarkerBefore: false,
        ...overrides,
    };
}

const summary = { decisions: [], pending_items: [], status: 'not_configured' as const };

describe('ingest tombstone write guard', () => {
    let store: MemoryStore;

    beforeEach(() => {
        store = new MemoryStore(openDb(':memory:'));
    });

    it.each(['purged', 'incognito'] as const)('does not recreate a %s transcript after the early scan gate', (blocker) => {
        const turn = makeTurn({ sessionId: `${blocker}-after-early-gate` });
        store.consent.grant(turn.projectPath);

        // The daemon's cheap pre-parse guard already observed no tombstone.
        expect(
            blocker === 'purged'
                ? store.isTranscriptPurged(turn.tool, turn.sessionId)
                : store.isTranscriptIncognito(turn.tool, turn.sessionId),
        ).toBe(false);
        // The tombstone commits before the synchronous session/turn write begins.
        if (blocker === 'purged') {
            store.database
                .prepare('INSERT INTO purged_transcripts (tool, native_id, purged_at) VALUES (?, ?, ?)')
                .run(turn.tool, turn.sessionId, '2026-08-24T00:00:02.000Z');
        } else {
            store.recordIncognitoTranscript(turn.tool, turn.sessionId);
        }

        expect(store.recordIngestedTurn(turn, {}, false, summary)).toBeUndefined();
        expect(store.isTranscriptIncognito(turn.tool, turn.sessionId)).toBe(true);
        expect(store.database.prepare('SELECT COUNT(*) AS count FROM incognito_transcripts').get()).toEqual({ count: 1 });
        expect(store.listProjects()).toEqual([]);
        expect(store.findSession(turn.tool, turn.sessionId)).toBeUndefined();
        expect(store.database.prepare('SELECT COUNT(*) AS count FROM memories').get()).toEqual({ count: 0 });
    });

    it.each(['ordinary', 'dropped'] as const)(
        'blocks pending consent at write time without recording an incognito tombstone for %s turns',
        (pathKind) => {
            const fixture = withGrantableTestDir(`elepha-pending-write-${pathKind}-`);
            const approvedRoot = path.join(fixture, 'approved');
            const physicalApprovedRoot = path.join(fixture, 'approved-before-swap');
            const unrelatedRoot = path.join(fixture, 'unrelated');
            mkdirSync(path.join(physicalApprovedRoot, 'project'), { recursive: true });
            mkdirSync(path.join(unrelatedRoot, 'project'), { recursive: true });
            symlinkSync(physicalApprovedRoot, approvedRoot);
            const projectPath = path.join(approvedRoot, 'project');
            const turn = makeTurn({ sessionId: `pending-${pathKind}`, projectPath });

            store.consent.grant(approvedRoot);
            expect(store.consent.consentState(projectPath)).toBe('approved');

            unlinkSync(approvedRoot);
            symlinkSync(unrelatedRoot, approvedRoot);
            expect(store.consent.consentState(projectPath)).toBe('pending');

            const result = pathKind === 'ordinary' ? store.recordIngestedTurn(turn, {}, false, summary) : store.recordDroppedTurn(turn, {});

            expect(result).toBe(pathKind === 'ordinary' ? undefined : false);
            expect(store.listProjects()).toEqual([]);
            expect(store.database.prepare('SELECT COUNT(*) AS count FROM sessions').get()).toEqual({ count: 0 });
            expect(store.getSessionCursor(turn.tool, turn.sessionId)).toBeUndefined();
            expect(store.database.prepare('SELECT COUNT(*) AS count FROM memories').get()).toEqual({ count: 0 });
            expect(store.database.prepare('SELECT COUNT(*) AS count FROM incognito_transcripts').get()).toEqual({ count: 0 });
        },
    );

    it('uses the same denied-consent guard for ordinary and dropped turns', () => {
        for (const path of ['ordinary', 'dropped'] as const) {
            const guardedStore = new MemoryStore(openDb(':memory:'));
            const turn = makeTurn({ sessionId: `denied-${path}`, projectPath: `/Users/test/denied-${path}` });
            guardedStore.consent.revoke(turn.projectPath);

            const result =
                path === 'ordinary' ? guardedStore.recordIngestedTurn(turn, {}, false, summary) : guardedStore.recordDroppedTurn(turn, {});

            expect(result).toBe(path === 'ordinary' ? undefined : false);
            expect(guardedStore.isTranscriptIncognito(turn.tool, turn.sessionId)).toBe(true);
            expect(guardedStore.listProjects()).toEqual([]);
            expect(guardedStore.database.prepare('SELECT COUNT(*) AS count FROM sessions').get()).toEqual({ count: 0 });
            expect(guardedStore.database.prepare('SELECT COUNT(*) AS count FROM memories').get()).toEqual({ count: 0 });
        }
    });

    it('writes a non-tombstoned transcript normally', () => {
        const turn = makeTurn();
        store.consent.grant(turn.projectPath);

        const result = store.recordIngestedTurn(turn, {}, false, summary);

        expect(result).toEqual(expect.objectContaining({ inserted: true }));
        expect(store.findSession(turn.tool, turn.sessionId)).toEqual(expect.objectContaining({ id: result?.session.id }));
        expect(store.database.prepare('SELECT COUNT(*) AS count FROM memories').get()).toEqual({ count: 1 });
    });

    it('creates or locates a non-tombstoned dropped session and advances its cursor', () => {
        const turn = makeTurn({ userMessage: 'drop this sentinel turn', cursor: '100|1|first' });
        const meta = { surface: 'cli' as const, gitBranch: 'main', kind: 'main' as const, customTitle: 'Native title' };
        store.consent.grant(turn.projectPath);

        expect(store.recordDroppedTurn(turn, meta)).toBe(true);
        const created = store.findSession(turn.tool, turn.sessionId);
        expect(created).toEqual(
            expect.objectContaining({
                cursor: '100|1|first',
                surface: 'cli',
                git_branch: 'main',
                kind: 'main',
                custom_title: 'Native title',
            }),
        );

        expect(store.recordDroppedTurn(makeTurn({ turnIndex: 1, cursor: '200|2|second' }), meta)).toBe(true);
        expect(store.findSession(turn.tool, turn.sessionId)).toEqual(expect.objectContaining({ id: created?.id, cursor: '200|2|second' }));
        expect(store.listProjects()).toHaveLength(1);
        expect(store.database.prepare('SELECT COUNT(*) AS count FROM sessions').get()).toEqual({ count: 1 });
        expect(store.database.prepare('SELECT COUNT(*) AS count FROM memories').get()).toEqual({ count: 0 });
    });

    it('rolls back the dropped project and session when cursor advancement fails', () => {
        const turn = makeTurn({ userMessage: 'must roll back', cursor: '300|3|failure' });
        store.consent.grant(turn.projectPath);
        store.database.exec(`
            CREATE TRIGGER fail_dropped_cursor_update
            BEFORE UPDATE OF cursor ON sessions
            BEGIN
                SELECT RAISE(ABORT, 'forced cursor failure');
            END;
        `);

        expect(() => store.recordDroppedTurn(turn, {})).toThrow('forced cursor failure');
        expect(store.listProjects()).toEqual([]);
        expect(store.findSession(turn.tool, turn.sessionId)).toBeUndefined();
        expect(store.getSessionCursor(turn.tool, turn.sessionId)).toBeUndefined();
        expect(store.database.prepare('SELECT COUNT(*) AS count FROM sessions').get()).toEqual({ count: 0 });
    });
});
