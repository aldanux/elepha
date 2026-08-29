import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { individualCandidates } from '../../src/cli/init-wizard.js';
import { IngestionDaemon } from '../../src/daemon/index.js';
import { CONSENT_GRANDFATHERED_AT_KEY, canonicalizeConsentRoots, grandfatherConsentRoots } from '../../src/storage/consent-store.js';
import { openDb } from '../../src/storage/db.js';
import { MemoryStore } from '../../src/storage/memory-store.js';
import type { ParsedTurn, ParseTurnsOptions, SessionAdapter } from '../../src/types/index.js';

const repositoryRoot = realpathSync(path.resolve(import.meta.dirname, '..', '..'));
const consentFixtures: string[] = [];

function consentFixture(prefix: string): string {
    mkdirSync(path.join(repositoryRoot, '.test-scratch'), { recursive: true });
    const fixture = mkdtempSync(path.join(repositoryRoot, '.test-scratch', prefix));
    consentFixtures.push(fixture);
    return fixture;
}

function insertHistoricalProject(db: ReturnType<typeof openDb>, projectPath: string, suffix: string): void {
    const project = db
        .prepare(
            `INSERT INTO projects (path, display_name, first_seen_at, last_seen_at)
             VALUES (?, ?, '2026-08-16T00:00:00.000Z', '2026-08-16T00:00:00.000Z')`,
        )
        .run(projectPath, suffix);
    const projectId = Number(project.lastInsertRowid);
    const session = db
        .prepare(
            `INSERT INTO sessions (tool, native_id, project_id, source_path, started_at, last_ingested_at)
             VALUES ('claude-code', ?, ?, ?, '2026-08-16T00:00:00.000Z', '2026-08-16T00:00:00.000Z')`,
        )
        .run(`session-${suffix}`, projectId, `/transcripts/${suffix}.jsonl`);
    db.prepare(
        `INSERT INTO memories (project_id, session_id, turn_index, tool, turn_started_at, decisions, files_touched, pending_items, created_at)
         VALUES (?, ?, 0, 'claude-code', '2026-08-16T00:00:00.000Z', '[]', '[]', '[]', '2026-08-16T00:00:00.000Z')`,
    ).run(projectId, Number(session.lastInsertRowid));
}

class FixedAdapter implements SessionAdapter {
    readonly tool = 'claude-code' as const;
    readonly watchGlobs = ['*.jsonl'];
    matches(): boolean {
        return true;
    }
    nativeSessionId(): string {
        return 'new-session';
    }
    async classifySession() {
        return { kind: 'primary' as const };
    }
    async classifyEmptySession() {
        return undefined;
    }
    async *parseTurns(_filePath: string, _sinceCursor?: string, _options?: ParseTurnsOptions): AsyncIterable<ParsedTurn> {}
}

class BackfillAdapter extends FixedAdapter {
    override nativeSessionId(): string {
        return 'backfill-session';
    }

    override async *parseTurns(filePath: string): AsyncIterable<ParsedTurn> {
        yield { ...pendingTurn('/Users/test/approved-backfill-root'), sourcePath: filePath, sessionId: this.nativeSessionId() };
    }
}

class ConsentGateAdapter extends FixedAdapter {
    parseCalls = 0;

    constructor(
        private readonly projectPath: string,
        private readonly failIfParsed = false,
    ) {
        super();
    }

    override nativeSessionId(): string {
        return 'consent-gate-session';
    }

    override async *parseTurns(filePath: string): AsyncIterable<ParsedTurn> {
        this.parseCalls++;
        if (this.failIfParsed) {
            throw new Error('hostile transcript body was parsed');
        }
        yield { ...pendingTurn(this.projectPath), sourcePath: filePath, sessionId: this.nativeSessionId() };
    }
}

type ScanFileSeam = {
    scanFile(
        adapter: SessionAdapter,
        filePath: string,
        closeTrailingOnIdle: boolean,
        onlyProjectRoot?: string,
    ): Promise<{ ingested: number; skipped?: { category: string } }>;
};

function pendingTurn(projectPath: string): ParsedTurn {
    return {
        tool: 'claude-code',
        sessionId: 'new-session',
        sourcePath: '/transcripts/new-session.jsonl',
        projectPath,
        turnIndex: 0,
        startedAt: '2026-08-16T00:00:00.000Z',
        endedAt: '2026-08-16T00:01:00.000Z',
        userMessage: 'new project',
        assistantText: 'reply',
        toolCalls: [],
        cursor: '1|1',
        hasExternalContent: false,
        resumeMarkerBefore: false,
    };
}

describe('consent roots', () => {
    afterEach(() => {
        vi.unstubAllEnvs();
        for (const fixture of consentFixtures.splice(0)) {
            try {
                rmSync(fixture, { recursive: true, force: true });
            } catch {
                // Cleanup is a courtesy; sandbox permissions must not fail the assertion.
            }
        }
    });

    it('anchors decided roots to their grant-time physical directory across a later symlink swap', () => {
        const fixture = consentFixture('elepha-consent-anchor-');
        const approvedRoot = path.join(fixture, 'approved');
        const physicalApprovedRoot = path.join(fixture, 'approved-before-swap');
        const unrelatedRoot = path.join(fixture, 'unrelated');
        const stableRoot = path.join(fixture, 'stable');
        mkdirSync(path.join(physicalApprovedRoot, 'project'), { recursive: true });
        mkdirSync(path.join(unrelatedRoot, 'project'), { recursive: true });
        mkdirSync(path.join(stableRoot, 'project'), { recursive: true });
        symlinkSync(physicalApprovedRoot, approvedRoot);

        const db = openDb(':memory:');
        const store = new MemoryStore(db);
        const approved = store.consent.grant(approvedRoot);
        store.consent.grant(stableRoot);
        expect(store.consent.consentState(path.join(approvedRoot, 'project'))).toBe('approved');

        unlinkSync(approvedRoot);
        symlinkSync(unrelatedRoot, approvedRoot);
        const swappedProject = path.join(approvedRoot, 'project');

        expect(store.consent.consentState(swappedProject)).toBe('pending');
        expect(store.consent.isConsented(swappedProject)).toBe(false);
        canonicalizeConsentRoots(db);
        expect(db.prepare('SELECT path FROM consent_roots WHERE ulid = ?').get(approved.ulid)).toEqual({ path: approved.path });
        expect(store.consent.consentState(path.join(stableRoot, 'project'))).toBe('approved');
    });

    it('normalizes and deduplicates benign decided-root spellings on open without touching distinct roots', () => {
        const fixture = mkdtempSync(path.join(tmpdir(), 'elepha-consent-legacy-alias-'));
        const physicalRoot = path.join(fixture, 'physical-root');
        const unrelatedRoot = path.join(fixture, 'unrelated-root');
        const dbPath = path.join(fixture, 'elepha.db');
        mkdirSync(path.join(physicalRoot, 'project'), { recursive: true });
        mkdirSync(unrelatedRoot);
        const canonicalPhysicalRoot = realpathSync(physicalRoot);
        const canonicalUnrelatedRoot = realpathSync(unrelatedRoot);

        const legacy = openDb(dbPath);
        const insert = legacy.prepare('INSERT INTO consent_roots (ulid, path, state, decided_at, source) VALUES (?, ?, ?, ?, ?)');
        insert.run('01J00000000000000000000001', `${canonicalPhysicalRoot}/`, 'approved', '2026-08-01T00:00:00.000Z', 'grandfathered');
        insert.run('01J00000000000000000000002', canonicalPhysicalRoot, 'denied', '2026-08-02T00:00:00.000Z', 'cli');
        insert.run('01J00000000000000000000003', canonicalUnrelatedRoot, 'approved', '2026-08-03T00:00:00.000Z', 'discovery');
        legacy.close();

        const db = openDb(dbPath);
        const store = new MemoryStore(db);
        expect(store.consent.list()).toEqual([
            {
                ulid: '01J00000000000000000000002',
                path: canonicalPhysicalRoot,
                state: 'denied',
                decided_at: '2026-08-02T00:00:00.000Z',
                source: 'cli',
            },
            {
                ulid: '01J00000000000000000000003',
                path: canonicalUnrelatedRoot,
                state: 'approved',
                decided_at: '2026-08-03T00:00:00.000Z',
                source: 'discovery',
            },
        ]);
        expect(store.consent.consentState(path.join(physicalRoot, 'project'))).toBe('denied');

        const beforeChanges = (db.prepare('SELECT total_changes() AS count').get() as { count: number }).count;
        canonicalizeConsentRoots(db);
        const afterChanges = (db.prepare('SELECT total_changes() AS count').get() as { count: number }).count;
        expect(afterChanges).toBe(beforeChanges);
    });

    it('breaks equal-depth normalized-root ties by the newest explicit decision regardless of stored path order', () => {
        const fixture = mkdtempSync(path.join(tmpdir(), 'elepha-consent-equal-depth-'));
        const physicalRoot = path.join(fixture, 'physical-root');
        mkdirSync(path.join(physicalRoot, 'project'), { recursive: true });
        const canonicalPhysicalRoot = realpathSync(physicalRoot);
        const alternateSpelling = `${canonicalPhysicalRoot}/`;

        const db = openDb(':memory:');
        db.prepare('INSERT INTO consent_roots (ulid, path, state, decided_at, source) VALUES (?, ?, ?, ?, ?)').run(
            '01J00000000000000000000001',
            alternateSpelling,
            'approved',
            '2026-08-01T00:00:00.000Z',
            'grandfathered',
        );
        db.prepare('INSERT INTO consent_roots (ulid, path, state, decided_at, source) VALUES (?, ?, ?, ?, ?)').run(
            '01J00000000000000000000002',
            canonicalPhysicalRoot,
            'denied',
            '2026-08-02T00:00:00.000Z',
            'cli',
        );

        const store = new MemoryStore(db);
        expect(store.consent.list().map((root) => root.path)).toEqual([canonicalPhysicalRoot, alternateSpelling]);
        expect(store.consent.consentState(path.join(physicalRoot, 'project'))).toBe('denied');
    });

    it('chooses canonical winners by explicit source, then decision time, then ulid', () => {
        const fixture = mkdtempSync(path.join(tmpdir(), 'elepha-consent-winner-order-'));
        const db = openDb(':memory:');
        const insert = db.prepare('INSERT INTO consent_roots (ulid, path, state, decided_at, source) VALUES (?, ?, ?, ?, ?)');

        const sourceRoot = path.join(fixture, 'source-root');
        mkdirSync(sourceRoot);
        const canonicalSourceRoot = realpathSync(sourceRoot);
        const sourceAlias = `${canonicalSourceRoot}/`;
        insert.run('01J00000000000000000000002', sourceAlias, 'approved', '2026-08-03T00:00:00.000Z', 'grandfathered');
        insert.run('01J00000000000000000000001', canonicalSourceRoot, 'denied', '2026-08-01T00:00:00.000Z', 'cli');

        const timeRoot = path.join(fixture, 'time-root');
        mkdirSync(timeRoot);
        const canonicalTimeRoot = realpathSync(timeRoot);
        const timeAlias = `${canonicalTimeRoot}/`;
        insert.run('01J00000000000000000000004', timeAlias, 'approved', '2026-08-01T00:00:00.000Z', 'cli');
        insert.run('01J00000000000000000000003', canonicalTimeRoot, 'denied', '2026-08-02T00:00:00.000Z', 'cli');

        const ulidRoot = path.join(fixture, 'ulid-root');
        mkdirSync(ulidRoot);
        const canonicalUlidRoot = realpathSync(ulidRoot);
        const ulidAlias = `${canonicalUlidRoot}/`;
        insert.run('01J00000000000000000000005', ulidAlias, 'approved', '2026-08-01T00:00:00.000Z', 'discovery');
        insert.run('01J00000000000000000000006', canonicalUlidRoot, 'denied', '2026-08-01T00:00:00.000Z', 'discovery');

        canonicalizeConsentRoots(db);

        expect(new MemoryStore(db).consent.list().map((root) => ({ ulid: root.ulid, path: root.path, state: root.state }))).toEqual([
            { ulid: '01J00000000000000000000001', path: canonicalSourceRoot, state: 'denied' },
            { ulid: '01J00000000000000000000003', path: canonicalTimeRoot, state: 'denied' },
            { ulid: '01J00000000000000000000006', path: canonicalUlidRoot, state: 'denied' },
        ]);
    });

    it('contains consent roots physically while retaining lexical fallback for paths that do not yet exist', () => {
        const fixture = consentFixture('elepha-consent-symlink-');
        const work = path.join(fixture, 'work');
        const outside = path.join(fixture, 'outside');
        const alias = path.join(fixture, 'work-alias');
        const escapedCwd = path.join(work, 'escape', 'secret');
        const aliasedCwd = path.join(alias, 'project');
        mkdirSync(path.join(work, 'project'), { recursive: true });
        mkdirSync(path.join(outside, 'secret'), { recursive: true });
        symlinkSync(outside, path.join(work, 'escape'));
        symlinkSync(work, alias);
        const canonicalWork = realpathSync(work);
        const missingCwd = path.join(canonicalWork, 'not-yet-created');

        const db = openDb(':memory:');
        const store = new MemoryStore(db);
        store.consent.grant(alias);

        expect(store.consent.list('approved').map((root) => root.path)).toEqual([canonicalWork]);
        expect(store.consent.consentState(escapedCwd)).toBe('pending');
        expect(store.consent.isConsented(escapedCwd)).toBe(false);
        expect(store.consent.consentState(aliasedCwd)).toBe('approved');
        expect(store.consent.isConsented(missingCwd)).toBe(true);

        const pending = repositoryRoot;
        expect(store.consent.recordPending(pending).state).toBe('pending');
        const pendingNudge = store.consent.captureOffNudge(pending);
        expect(pendingNudge).toMatchObject({ path: realpathSync(pending), state: 'pending' });
        expect(store.consent.captureOffNudge(pending)).toEqual(pendingNudge);
        const denied = store.consent.revoke(pending);
        expect(denied.state).toBe('denied');
        db.prepare('UPDATE consent_roots SET nudged_at = ? WHERE ulid = ?').run('2026-08-25T00:00:00.000Z', denied.ulid);
        const deniedNudge = store.consent.captureOffNudge(pending);
        expect(deniedNudge).toMatchObject({ ulid: denied.ulid, state: 'denied' });
        expect(store.consent.captureOffNudge(pending)).toMatchObject({ ulid: denied.ulid, state: 'denied' });
        expect(store.consent.grant(pending).state).toBe('approved');
        expect(store.consent.captureOffNudge(pending)).toBeUndefined();
    });

    it('refuses to grant a symlink alias to the home directory', () => {
        const fixture = consentFixture('consent-refused-home-');
        const alias = path.join(fixture, 'home-link');
        symlinkSync(homedir(), alias);
        const db = openDb(':memory:');
        const store = new MemoryStore(db);

        try {
            expect(() => store.consent.grant(alias)).toThrow(/refused project root/);
            expect(store.consent.list()).toEqual([]);
        } finally {
            try {
                unlinkSync(alias);
                rmSync(fixture, { recursive: true, force: true });
            } catch {
                // Cleanup is a courtesy; sandbox permissions must not fail the assertion.
            }
        }
    });

    it('returns an existing explicit decision for a refused root unchanged', () => {
        const db = openDb(':memory:');
        const home = realpathSync(homedir());
        const decision = {
            ulid: '01J00000000000000000000007',
            path: home,
            state: 'denied',
            decided_at: '2026-08-28T16:55:51.000Z',
            source: 'discovery',
        } as const;
        db.prepare('INSERT INTO consent_roots (ulid, path, state, decided_at, source) VALUES (?, ?, ?, ?, ?)').run(
            decision.ulid,
            decision.path,
            decision.state,
            decision.decided_at,
            decision.source,
        );

        expect(new MemoryStore(db).consent.captureOffNudge(home)).toEqual(decision);
    });

    it('re-granting an approved folder preserves denied descendant projects', () => {
        const db = openDb(':memory:');
        const store = new MemoryStore(db);
        const folder = '/root/folder';
        const project = `${folder}/proj`;
        store.consent.grant(folder);
        store.consent.revoke(project);

        store.consent.grant(folder);

        expect(store.consent.list('denied').map((root) => root.path)).toContain(project);
        expect(store.consent.consentState(project)).toBe('denied');
        expect(store.consent.isConsented(project)).toBe(false);
    });

    it('lets a denied child override an approved ancestor in consent and wizard candidates', () => {
        const db = openDb(':memory:');
        const store = new MemoryStore(db);
        const folder = '/root/folder';
        const project = `${folder}/proj`;
        const sibling = `${folder}/sibling`;
        store.consent.grant(folder);
        store.consent.revoke(project);

        expect(store.consent.isConsented(project)).toBe(false);
        expect(store.consent.consentState(project)).toBe('denied');
        expect(
            individualCandidates(
                [
                    { ...pendingTurn(project), root: project },
                    { ...pendingTurn(sibling), root: sibling },
                ].map(({ root }) => ({
                    root,
                    displayName: root.split('/').at(-1) ?? root,
                    tools: ['codex'],
                    sessionCount: 1,
                    earliestSessionAt: '',
                    latestSessionAt: '',
                })),
                (root) => store.consent.consentState(root),
            ),
        ).toEqual([
            expect.objectContaining({
                root: project,
                approved: false,
                paused: true,
                label: 'proj',
                hint: `consent paused · 1 session · ${project}`,
            }),
            expect.objectContaining({
                root: sibling,
                approved: true,
                paused: false,
                hint: `consent approved · 1 session · ${sibling}`,
            }),
        ]);
    });

    it('grandfathers one group root per ProjectSet, denies temporary roots, and preserves every turn row', () => {
        const db = openDb(':memory:');
        insertHistoricalProject(db, '/Users/test/elepha-ext', 'ext-root');
        insertHistoricalProject(db, '/Users/test/elepha-ext/extension/src', 'ext-child');
        insertHistoricalProject(db, '/private/tmp/claude-501/scratchpad/hooktest', 'temporary');
        db.prepare('DELETE FROM meta WHERE key = ?').run(CONSENT_GRANDFATHERED_AT_KEY);
        const before = (db.prepare('SELECT COUNT(*) AS count FROM memories').get() as { count: number }).count;

        const inserted = grandfatherConsentRoots(db);
        const after = (db.prepare('SELECT COUNT(*) AS count FROM memories').get() as { count: number }).count;

        expect(after).toBe(before);
        expect(inserted.map((root) => ({ path: root.path, state: root.state }))).toEqual([
            { path: '/private/tmp/claude-501/scratchpad/hooktest', state: 'denied' },
            { path: '/Users/test/elepha-ext', state: 'approved' },
        ]);
        expect(inserted.every((root) => /^[0-9A-HJKMNP-TV-Z]{26}$/.test(root.ulid))).toBe(true);
        expect(grandfatherConsentRoots(db)).toEqual([]);
    });

    it('does not restore grandfathered approvals after every consent row is removed and the database reopens', () => {
        const fixture = consentFixture('elepha-consent-grandfather-pruned-');
        const dbPath = path.join(fixture, 'elepha.db');
        const projectRoot = path.join(fixture, 'historical-project');
        mkdirSync(projectRoot);

        const db = openDb(dbPath);
        insertHistoricalProject(db, projectRoot, 'historical');
        const store = new MemoryStore(db);
        const granted = store.consent.grant(projectRoot);
        expect(store.consent.remove(granted.ulid)).toBe(true);
        expect(store.consent.list()).toEqual([]);
        db.close();

        const reopened = openDb(dbPath);
        expect(new MemoryStore(reopened).consent.list()).toEqual([]);
        reopened.close();
    });

    it('grandfathers a pre-consent database exactly once and records the marker even after its rows are removed', () => {
        const fixture = consentFixture('elepha-consent-grandfather-once-');
        const dbPath = path.join(fixture, 'elepha.db');
        const projectRoot = path.join(fixture, 'historical-project');
        mkdirSync(projectRoot);

        const legacy = openDb(dbPath);
        insertHistoricalProject(legacy, projectRoot, 'historical');
        legacy.prepare('DELETE FROM meta WHERE key = ?').run(CONSENT_GRANDFATHERED_AT_KEY);
        legacy.close();

        const firstOpen = openDb(dbPath);
        expect(new MemoryStore(firstOpen).consent.list()).toEqual([
            expect.objectContaining({ path: realpathSync(projectRoot), state: 'approved', source: 'grandfathered' }),
        ]);
        const marker = firstOpen.prepare('SELECT value FROM meta WHERE key = ?').get(CONSENT_GRANDFATHERED_AT_KEY) as
            | { value: string }
            | undefined;
        expect(marker).toBeDefined();
        expect(Number.isNaN(Date.parse(marker?.value ?? ''))).toBe(false);
        firstOpen.prepare('DELETE FROM consent_roots').run();
        firstOpen.close();

        const secondOpen = openDb(dbPath);
        expect(new MemoryStore(secondOpen).consent.list()).toEqual([]);
        expect(secondOpen.prepare('SELECT value FROM meta WHERE key = ?').get(CONSENT_GRANDFATHERED_AT_KEY)).toEqual(marker);
        secondOpen.close();
    });

    it('backfills the marker for an existing consent database and never grandfathers it after deletion', () => {
        const fixture = consentFixture('elepha-consent-grandfather-backfill-');
        const dbPath = path.join(fixture, 'elepha.db');
        const projectRoot = path.join(fixture, 'historical-project');
        mkdirSync(projectRoot);

        const legacy = openDb(dbPath);
        insertHistoricalProject(legacy, projectRoot, 'historical');
        new MemoryStore(legacy).consent.grant(projectRoot);
        legacy.prepare('DELETE FROM meta WHERE key = ?').run(CONSENT_GRANDFATHERED_AT_KEY);
        legacy.close();

        const migrated = openDb(dbPath);
        expect(new MemoryStore(migrated).consent.list()).toEqual([
            expect.objectContaining({ path: realpathSync(projectRoot), state: 'approved', source: 'cli' }),
        ]);
        const marker = migrated.prepare('SELECT value FROM meta WHERE key = ?').get(CONSENT_GRANDFATHERED_AT_KEY) as
            | { value: string }
            | undefined;
        expect(marker).toBeDefined();
        expect(Number.isNaN(Date.parse(marker?.value ?? ''))).toBe(false);
        migrated.prepare('DELETE FROM consent_roots').run();
        migrated.close();

        const reopened = openDb(dbPath);
        expect(new MemoryStore(reopened).consent.list()).toEqual([]);
        reopened.close();
    });

    it('keeps the turn-level consent check as a no-persistence fallback without creating a post-parse pending root', async () => {
        const db = openDb(':memory:');
        const store = new MemoryStore(db);
        const logs: string[] = [];
        const daemon = new IngestionDaemon({ store, adapters: [new FixedAdapter()], log: (line) => logs.push(line) }) as unknown as {
            persistTurn(adapter: SessionAdapter, turn: ParsedTurn): Promise<boolean>;
            skippedFiles: Map<string, { category: string }>;
        };
        const adapter = new FixedAdapter();
        const turn = pendingTurn('/Users/test/not-yet-approved');

        expect(await daemon.persistTurn(adapter, turn)).toBe(false);
        expect(await daemon.persistTurn(adapter, turn)).toBe(false);
        expect(store.consent.list('pending')).toEqual([]);
        // The drop is visible exactly once per transcript, never per turn.
        expect(logs).toEqual([expect.stringContaining('outside every approved root')]);
        expect(daemon.skippedFiles.size).toBe(0);
        expect(store.listProjects()).toEqual([]);
        expect((db.prepare('SELECT COUNT(*) AS count FROM sessions').get() as { count: number }).count).toBe(0);
        expect((db.prepare('SELECT COUNT(*) AS count FROM memories').get() as { count: number }).count).toBe(0);
    });

    it('warns once per transcript through the deduplicated daemon warning path when a later turn climbs above the approved root', async () => {
        const db = openDb(':memory:');
        const store = new MemoryStore(db);
        const logs: string[] = [];
        const daemon = new IngestionDaemon({ store, adapters: [new FixedAdapter()], log: (line) => logs.push(line) }) as unknown as {
            persistTurn(adapter: SessionAdapter, turn: ParsedTurn): Promise<boolean>;
            skippedFiles: Map<string, { category: string }>;
        };
        const adapter = new FixedAdapter();
        const approved = '/Users/test/climb-root/repo';
        store.consent.grant(approved);
        const climbed = { ...pendingTurn('/Users/test/climb-root'), sourcePath: '/transcripts/climbing.jsonl' };

        expect(await daemon.persistTurn(adapter, climbed)).toBe(false);
        expect(await daemon.persistTurn(adapter, { ...climbed, turnIndex: 1, cursor: '2|2' })).toBe(false);
        expect(await daemon.persistTurn(adapter, { ...climbed, turnIndex: 2, cursor: '3|3' })).toBe(false);

        expect(logs).toHaveLength(1);
        expect(logs[0]).toContain('/transcripts/climbing.jsonl');
        expect(logs[0]).toContain('/Users/test/climb-root');
        expect(logs[0]).toContain('outside every approved root');
        // Drop semantics are unchanged: no pending root, no skip record, no rows.
        expect(store.consent.list('pending')).toEqual([]);
        expect(daemon.skippedFiles.size).toBe(0);
        expect(store.listProjects()).toEqual([]);
        expect((db.prepare('SELECT COUNT(*) AS count FROM sessions').get() as { count: number }).count).toBe(0);
        expect((db.prepare('SELECT COUNT(*) AS count FROM memories').get() as { count: number }).count).toBe(0);
    });

    it('tombstones a denied turn without recording any project, session, or memory', async () => {
        const db = openDb(':memory:');
        const store = new MemoryStore(db);
        const logs: string[] = [];
        const daemon = new IngestionDaemon({ store, adapters: [new FixedAdapter()], log: (line) => logs.push(line) }) as unknown as {
            persistTurn(adapter: SessionAdapter, turn: ParsedTurn): Promise<boolean>;
            skippedFiles: Map<string, { category: string }>;
        };
        const adapter = new FixedAdapter();
        const root = '/Users/test/declined-root';
        store.consent.recordPending(root);
        store.consent.revoke(root);

        expect(await daemon.persistTurn(adapter, pendingTurn(root))).toBe(false);
        expect(store.consent.list().map((consentRoot) => ({ path: consentRoot.path, state: consentRoot.state }))).toEqual([
            { path: root, state: 'denied' },
        ]);
        expect(logs).toEqual([]);
        expect(daemon.skippedFiles.size).toBe(0);
        expect(store.isTranscriptIncognito('claude-code', 'new-session')).toBe(true);
        expect(store.listProjects()).toEqual([]);
        expect((db.prepare('SELECT COUNT(*) AS count FROM sessions').get() as { count: number }).count).toBe(0);
        expect((db.prepare('SELECT COUNT(*) AS count FROM memories').get() as { count: number }).count).toBe(0);
    });

    it('purges every descendant project row when a consent root is revoked', () => {
        const db = openDb(':memory:');
        const store = new MemoryStore(db);
        const root = '/Users/test/revoked-root';
        const child = `${root}/packages/app`;
        const rootProject = store.upsertProject(root);
        const childProject = store.upsertProject(child);
        store.upsertSession('claude-code', 'root-session', rootProject.id, '/transcripts/root.jsonl');
        store.upsertSession('claude-code', 'child-session', childProject.id, '/transcripts/child.jsonl');

        const plan = store.planPurge({ projectRoot: root });
        expect(plan.sessions.map((session) => session.projectPath)).toEqual([root, child]);
        store.purge({ projectRoot: root });
        expect(store.planPurge({ projectRoot: root }).sessions).toEqual([]);
    });

    it('backfills a newly approved root in capture-only mode', async () => {
        const db = openDb(':memory:');
        const store = new MemoryStore(db);
        const directory = mkdtempSync(path.join(tmpdir(), 'elepha-consent-backfill-'));
        const claudeConfigDir = path.join(directory, '.claude');
        vi.stubEnv('CLAUDE_CONFIG_DIR', claudeConfigDir);
        const watchRoot = path.join(claudeConfigDir, 'projects');
        const transcript = path.join(watchRoot, 'session.jsonl');
        mkdirSync(watchRoot, { recursive: true });
        const approved = '/Users/test/approved-backfill-root';
        writeFileSync(transcript, `${JSON.stringify({ cwd: approved })}\n`);
        store.consent.grant(approved);
        const daemon = new IngestionDaemon({ store, adapters: [new BackfillAdapter()], watchRoots: [watchRoot] });

        expect(await daemon.backfillApprovedRoot(approved)).toBe(1);
        expect(store.listProjects().map((project) => project.path)).toEqual([approved]);
        expect((db.prepare('SELECT COUNT(*) AS count FROM memories').get() as { count: number }).count).toBe(1);
    });

    it('gates unapproved transcript bodies by metadata before parseTurns and records only a pending root', async () => {
        const directory = mkdtempSync(path.join(tmpdir(), 'elepha-consent-gate-'));
        const claudeConfigDir = path.join(directory, '.claude');
        vi.stubEnv('CLAUDE_CONFIG_DIR', claudeConfigDir);
        const watchRoot = path.join(claudeConfigDir, 'projects');
        const unapproved = repositoryRoot;
        const transcript = path.join(watchRoot, 'hostile.jsonl');
        mkdirSync(watchRoot, { recursive: true });
        writeFileSync(transcript, `${JSON.stringify({ cwd: unapproved })}\nthis body is deliberately not JSON\n`);

        const db = openDb(':memory:');
        const store = new MemoryStore(db);
        const adapter = new ConsentGateAdapter(unapproved, true);
        const daemon = new IngestionDaemon({ store, adapters: [adapter], watchRoots: [watchRoot] }) as unknown as ScanFileSeam;

        await expect(daemon.scanFile(adapter, transcript, true)).resolves.toMatchObject({
            ingested: 0,
            skipped: { category: 'unapproved root' },
        });
        expect(adapter.parseCalls).toBe(0);
        expect(store.consent.list('pending').map((root) => root.path)).toEqual([unapproved]);
        expect(store.listProjects()).toEqual([]);
        expect((db.prepare('SELECT COUNT(*) AS count FROM sessions').get() as { count: number }).count).toBe(0);
        expect((db.prepare('SELECT COUNT(*) AS count FROM memories').get() as { count: number }).count).toBe(0);
    });

    it('does not record pending roots for missing directories or tool-internal cwds', async () => {
        const directory = mkdtempSync(path.join(tmpdir(), 'elepha-consent-gate-'));
        const claudeConfigDir = path.join(directory, '.claude');
        vi.stubEnv('CLAUDE_CONFIG_DIR', claudeConfigDir);
        const watchRoot = path.join(claudeConfigDir, 'projects');
        const toolInternalCwd = path.join(claudeConfigDir, 'memories');
        const missingCwd = path.join(repositoryRoot, `.elepha-consent-gate-deleted-${path.basename(directory)}`);
        const toolInternalTranscript = path.join(watchRoot, 'tool-internal.jsonl');
        const missingTranscript = path.join(watchRoot, 'missing.jsonl');
        mkdirSync(watchRoot, { recursive: true });
        mkdirSync(toolInternalCwd);
        writeFileSync(toolInternalTranscript, `${JSON.stringify({ cwd: toolInternalCwd })}\n`);
        writeFileSync(missingTranscript, `${JSON.stringify({ cwd: missingCwd })}\n`);

        const db = openDb(':memory:');
        const store = new MemoryStore(db);
        const toolInternalAdapter = new ConsentGateAdapter(toolInternalCwd, true);
        const missingAdapter = new ConsentGateAdapter(missingCwd, true);
        const daemon = new IngestionDaemon({ store, adapters: [toolInternalAdapter], watchRoots: [watchRoot] }) as unknown as ScanFileSeam;

        await expect(daemon.scanFile(toolInternalAdapter, toolInternalTranscript, true)).resolves.toMatchObject({
            ingested: 0,
            skipped: { category: 'refused root' },
        });
        await expect(daemon.scanFile(missingAdapter, missingTranscript, true)).resolves.toMatchObject({
            ingested: 0,
            skipped: { category: 'unapproved root' },
        });
        expect(toolInternalAdapter.parseCalls).toBe(0);
        expect(missingAdapter.parseCalls).toBe(0);
        expect(store.consent.list('pending')).toEqual([]);
        expect(store.isTranscriptIncognito('claude-code', 'consent-gate-session')).toBe(false);

        store.consent.revoke(missingCwd);
        await expect(daemon.scanFile(missingAdapter, missingTranscript, true)).resolves.toMatchObject({ ingested: 0 });
        expect(store.isTranscriptIncognito('claude-code', 'consent-gate-session')).toBe(true);
        expect(store.consent.list('pending')).toEqual([]);
    });

    it('still fully ingests an approved transcript and skips an out-of-root backfill before parseTurns', async () => {
        const directory = mkdtempSync(path.join(tmpdir(), 'elepha-consent-gate-'));
        const claudeConfigDir = path.join(directory, '.claude');
        vi.stubEnv('CLAUDE_CONFIG_DIR', claudeConfigDir);
        const watchRoot = path.join(claudeConfigDir, 'projects');
        const approved = repositoryRoot;
        const outside = '/Users/test/consent-gate-outside';
        const approvedTranscript = path.join(watchRoot, 'approved.jsonl');
        const outsideTranscript = path.join(watchRoot, 'outside.jsonl');
        mkdirSync(watchRoot, { recursive: true });
        writeFileSync(approvedTranscript, `${JSON.stringify({ cwd: approved })}\n`);
        writeFileSync(outsideTranscript, `${JSON.stringify({ cwd: outside })}\nthis body must not be parsed\n`);

        const db = openDb(':memory:');
        const store = new MemoryStore(db);
        store.consent.grant(approved);
        const approvedAdapter = new ConsentGateAdapter(approved);
        const outsideAdapter = new ConsentGateAdapter(outside, true);
        const daemon = new IngestionDaemon({ store, adapters: [approvedAdapter], watchRoots: [watchRoot] }) as unknown as ScanFileSeam;

        await expect(daemon.scanFile(approvedAdapter, approvedTranscript, true)).resolves.toMatchObject({ ingested: 1 });
        expect(approvedAdapter.parseCalls).toBe(1);
        expect(store.listProjects().map((project) => project.path)).toEqual([approved]);
        expect((db.prepare('SELECT COUNT(*) AS count FROM memories').get() as { count: number }).count).toBe(1);

        await expect(daemon.scanFile(outsideAdapter, outsideTranscript, true, approved)).resolves.toMatchObject({
            ingested: 0,
            skipped: { category: 'unapproved root' },
        });
        expect(outsideAdapter.parseCalls).toBe(0);
    });
});
