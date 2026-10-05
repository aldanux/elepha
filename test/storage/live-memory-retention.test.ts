import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3-multiple-ciphers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_MEMORY_CONFIG } from '../../src/config/memory-config.js';
import { IngestionDaemon } from '../../src/daemon/index.js';
import { applyBackfill, type BackfillDeriver } from '../../src/storage/backfill-runner.js';
import { openInitializedKeyedDatabase, openKeyedDatabase, openUnmanagedDb } from '../../src/storage/db.js';
import { isLiveMemoryCapacityGuardError } from '../../src/storage/live-memory-capacity-guard.js';
import {
    LIVE_MEMORY_RETENTION_POLICY,
    LiveMemoryCaptureDeferredError,
    type LiveMemoryDeferralReason,
    type LiveMemoryRetentionPolicy,
    LiveMemoryRetentionVerificationError,
    readLiveMemoryRetentionReport,
} from '../../src/storage/live-memory-retention.js';
import { measureLiveMemoryByNativeSession, nativeSessionKey, readLiveMemoryUsage } from '../../src/storage/live-memory-usage.js';
import { MemoryStore, type ProjectRow } from '../../src/storage/memory-store.js';

import type { ParsedTurn, SessionAdapter, ToolName } from '../../src/types/index.js';
import { createTestDb, seedRollup, type TestDatabase } from '../helpers/db.js';
import { expectLiveMemoryCurrent } from '../helpers/live-memory.js';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = Date.parse('2026-09-30T00:00:00.000Z');
const OLD_INGEST = '2026-02-01T00:00:00.000Z';
const TURN_TIME = '2026-06-01T00:00:00.000Z';
const FIXED_KEY = Buffer.alloc(32, 7);
const summary = { decisions: [], pending_items: [], status: 'not_configured' as const };

interface Harness {
    fixture: TestDatabase;
    victims: ProjectRow;
    currentPath: string;
}

function harness(fixture: TestDatabase = createTestDb('elepha-retention-')): Harness {
    const victimsPath = path.join(fixture.directory, 'victims');
    const currentPath = path.join(fixture.directory, 'current');
    mkdirSync(victimsPath, { recursive: true });
    mkdirSync(currentPath, { recursive: true });
    fixture.store.consent.grant(victimsPath);
    fixture.store.consent.grant(currentPath);
    return { fixture, victims: fixture.store.upsertProject(victimsPath), currentPath };
}

function parsed(tool: ToolName, nativeId: string, projectPath: string, turnIndex: number, startedAt: string, text: string): ParsedTurn {
    return {
        tool,
        sessionId: nativeId,
        sourcePath: path.join(projectPath, `${nativeId}.jsonl`),
        projectPath,
        turnIndex,
        startedAt,
        endedAt: startedAt,
        userMessage: text,
        assistantText: `answer for ${nativeId}`,
        toolCalls: [],
        cursor: `${turnIndex + 1}`,
        hasExternalContent: false,
        resumeMarkerBefore: false,
    };
}

interface SeedOptions {
    tool?: ToolName;
    startedAt?: string;
    segments?: number;
    project?: ProjectRow;
    lastIngestedAt?: string;
    turnStartedAt?: string;
}

// One native session, optionally split into segments, each with one captured turn.
function seedUnit(h: Harness, nativeId: string, options: SeedOptions = {}): void {
    const project = options.project ?? h.victims;
    const tool = options.tool ?? 'codex';
    const sourcePath = path.join(project.path, `${nativeId}.jsonl`);
    let session = h.fixture.store.upsertSession(tool, nativeId, project.id, sourcePath);
    for (let segment = 0; segment < (options.segments ?? 1); segment++) {
        if (segment > 0) {
            session = h.fixture.store.startNextSegment(session, project.id, sourcePath);
        }
        // Turn times deliberately disagree with the session start: cleanup
        // orders by sessions.started_at, never by the first turn.
        const turn = parsed(
            tool,
            nativeId,
            project.path,
            segment,
            options.turnStartedAt ?? TURN_TIME,
            `needle${nativeId} ${'x'.repeat(300)}`,
        );
        expect(h.fixture.store.recordTurn(turn, session.id, project.id, summary, true)).toBe(true);
    }
    h.fixture.db
        .prepare('UPDATE sessions SET last_ingested_at = ?, started_at = ? WHERE tool = ? AND native_id = ?')
        .run(options.lastIngestedAt ?? OLD_INGEST, options.startedAt ?? '2026-01-01T00:00:00.000Z', tool, nativeId);
}

function unitBytes(h: Harness, tool: ToolName, nativeId: string): number {
    const unit = measureLiveMemoryByNativeSession(h.fixture.db).get(nativeSessionKey(tool, nativeId));
    if (unit === undefined) {
        throw new Error(`no unit ${tool}:${nativeId}`);
    }
    return unit.bytes;
}

function nativeSessions(h: Harness): string[] {
    return (
        h.fixture.db.prepare('SELECT DISTINCT tool, native_id FROM sessions ORDER BY tool, native_id').all() as Array<{
            tool: string;
            native_id: string;
        }>
    ).map((row) => `${row.tool}:${row.native_id}`);
}

function currentTurn(h: Harness): ParsedTurn {
    return parsed('codex', 'current', h.currentPath, 0, '2026-09-29T00:00:00.000Z', `needlecurrent ${'y'.repeat(600)}`);
}

// Bytes one write adds, measured by running it and rolling it back.
function measureWrite(h: Harness, write: () => void): number {
    const rollback = new Error('measurement rollback');
    let delta = 0;
    try {
        h.fixture.db.transaction(() => {
            const before = readLiveMemoryUsage(h.fixture.db);
            write();
            delta = readLiveMemoryUsage(h.fixture.db) - before;
            throw rollback;
        })();
    } catch (error) {
        if (error !== rollback) {
            throw error;
        }
    }
    return delta;
}

interface RetentionStore {
    store: MemoryStore;
    backups: string[];
    clock: { now: number };
}

// A plaintext stand-in for the encrypted production backup: a real on-disk
// copy that the policy's own verification inspects before any removal.
function retentionStore(h: Harness, overrides: Partial<LiveMemoryRetentionPolicy> = {}, beforeBackup?: () => void): RetentionStore {
    const backups: string[] = [];
    const clock = { now: NOW };
    const policy: LiveMemoryRetentionPolicy = {
        capacityBytes: Number.MAX_SAFE_INTEGER,
        targetBytes: Number.MAX_SAFE_INTEGER,
        warningBytes: 0,
        activeWindowMs: DAY,
        retryMs: HOUR,
        now: () => clock.now,
        backup: (db, verify) => {
            beforeBackup?.();
            const backupPath = path.join(h.fixture.directory, `retention-backup-${backups.length}.db`);
            db.prepare('VACUUM INTO ?').run(backupPath);
            db.prepare('ATTACH DATABASE ? AS retention_copy').run(backupPath);
            try {
                verify('retention_copy');
            } finally {
                db.exec('DETACH DATABASE retention_copy');
            }
            backups.push(backupPath);
            return backupPath;
        },
        ...overrides,
    };
    return {
        store: new MemoryStore(h.fixture.db, { resolveGitRoot: () => null, resolveGitRemote: () => null, liveMemoryRetention: policy }),
        backups,
        clock,
    };
}

// Sets capacity exactly at the usage the current write would reach, and the
// target `required` bytes below it.
function atCapacity(h: Harness, required: number, overrides: Partial<LiveMemoryRetentionPolicy> = {}, beforeBackup?: () => void) {
    const before = readLiveMemoryUsage(h.fixture.db);
    const write = measureWrite(h, () => {
        h.fixture.store.recordIngestedTurn(currentTurn(h), {}, false, summary, true);
    });
    expect(write).toBeGreaterThan(0);
    const capacityBytes = before + write;
    return { before, write, ...retentionStore(h, { capacityBytes, targetBytes: capacityBytes - required, ...overrides }, beforeBackup) };
}

function expectDeferred(write: () => unknown, reason: LiveMemoryDeferralReason): void {
    let caught: unknown;
    try {
        write();
    } catch (error) {
        caught = error;
    }
    expect(caught).toBeInstanceOf(LiveMemoryCaptureDeferredError);
    expect((caught as LiveMemoryCaptureDeferredError).reason).toBe(reason);
}

function seedOrderingCorpus(h: Harness): void {
    seedUnit(h, 'codexa', { startedAt: '2026-01-02T00:00:00.000Z' });
    seedUnit(h, 'codexb', { startedAt: '2026-01-01T00:00:00.000Z' });
    seedUnit(h, 'claudez', { tool: 'claude-code', startedAt: '2026-01-01T00:00:00.000Z' });
    seedUnit(h, 'invalidb', { startedAt: 'not-a-time' });
    seedUnit(h, 'invalida', { startedAt: '12345' });
}

describe('live-memory retention at capacity', () => {
    it('commits a write that stays below capacity without removing anything', () => {
        const h = harness();
        seedOrderingCorpus(h);
        const before = nativeSessions(h);
        const { store, backups } = atCapacity(h, 1, { capacityBytes: readLiveMemoryUsage(h.fixture.db) + 10_000_000 });

        expect(store.recordIngestedTurn(currentTurn(h), {}, false, summary, true)?.inserted).toBe(true);

        expect(nativeSessions(h)).toEqual([...before, 'codex:current'].sort());
        expect(backups).toEqual([]);
        expectLiveMemoryCurrent(h.fixture.db);
    });

    it('removes the smallest oldest-first prefix, ordered by source start then tool and native id, landing exactly on the target', () => {
        const h = harness();
        seedOrderingCorpus(h);
        const required = unitBytes(h, 'claude-code', 'claudez') + unitBytes(h, 'codex', 'codexb');
        const { store, backups, before, write } = atCapacity(h, required);

        expect(store.recordIngestedTurn(currentTurn(h), {}, false, summary, true)?.inserted).toBe(true);

        expect(nativeSessions(h)).toEqual(['codex:codexa', 'codex:current', 'codex:invalida', 'codex:invalidb']);
        expect(readLiveMemoryUsage(h.fixture.db)).toBe(before + write - required);
        expectLiveMemoryCurrent(h.fixture.db);
        // The verified backup taken before the commit still holds what was removed.
        expect(backups).toHaveLength(1);
        const copy = new Database(backups[0]!, { readonly: true });
        expect(copy.prepare("SELECT COUNT(*) AS count FROM sessions WHERE native_id IN ('claudez', 'codexb')").get()).toEqual({
            count: 2,
        });
        copy.close();
        const report = readLiveMemoryRetentionReport(h.fixture.db, 10);
        expect(report.recentRemovals.map((row) => `${row.tool}:${row.native_id}`).sort()).toEqual(['claude-code:claudez', 'codex:codexb']);
        expect(report.removedBytes).toBe(required);
        expect(report.state).toMatchObject({ outcome: 'removed', backup_path: backups[0] });
    });

    it('reaches invalid-time sessions only after every valid one, in identity order, and only as far as needed', () => {
        const h = harness();
        seedOrderingCorpus(h);
        const valid = unitBytes(h, 'claude-code', 'claudez') + unitBytes(h, 'codex', 'codexb') + unitBytes(h, 'codex', 'codexa');
        const { store } = atCapacity(h, valid + 1);

        store.recordIngestedTurn(currentTurn(h), {}, false, summary, true);

        expect(nativeSessions(h)).toEqual(['codex:current', 'codex:invalidb']);
    });

    it('removes every segment of a segmented native session as one unit', () => {
        const h = harness();
        seedUnit(h, 'segmented', { startedAt: '2026-01-01T00:00:00.000Z', segments: 3 });
        seedUnit(h, 'newer', { startedAt: '2026-01-05T00:00:00.000Z' });
        expect(h.fixture.db.prepare("SELECT COUNT(*) AS count FROM sessions WHERE native_id = 'segmented'").get()).toEqual({ count: 3 });
        const { store } = atCapacity(h, 1);

        store.recordIngestedTurn(currentTurn(h), {}, false, summary, true);

        expect(nativeSessions(h)).toEqual(['codex:current', 'codex:newer']);
        expect(readLiveMemoryRetentionReport(h.fixture.db, 10).recentRemovals).toEqual([
            expect.objectContaining({ native_id: 'segmented', source_started_at: '2026-01-01T00:00:00.000Z' }),
        ]);
    });
});

// The oldest sessions here are each ineligible for a different reason.
function seedIneligible(h: Harness): void {
    seedUnit(h, 'openturn');
    const open = h.fixture.store.findSession('codex', 'openturn')!;
    h.fixture.db
        .prepare(
            `INSERT INTO open_turns (tool, native_session_id, session_id, project_id, source_generation, turn_index,
                candidate_cursor, source_path, source_dev, source_ino, source_size, source_mtime_ms, source_revision,
                source_digest, failed_at, observed_at, receipt_coverage)
             VALUES ('codex', 'openturn', ?, ?, 0, 1, 'c', ?, '1', '2', 1, 1, 'r', 'd', ?, ?, 'complete')`,
        )
        .run(open.id, h.victims.id, open.source_path, OLD_INGEST, OLD_INGEST);
    seedUnit(h, 'recent', { lastIngestedAt: new Date(NOW - HOUR).toISOString() });
    const pendingPath = path.join(h.fixture.directory, 'undecided');
    mkdirSync(pendingPath);
    seedUnit(h, 'pending', { project: h.fixture.store.upsertProject(pendingPath) });
    seedUnit(h, 'parent');
    seedUnit(h, 'child', { startedAt: '2026-01-20T00:00:00.000Z', lastIngestedAt: new Date(NOW - HOUR).toISOString() });
    const child = h.fixture.store.findSession('codex', 'child')!;
    seedRollup(h.fixture, { project: h.victims, session: child });
    h.fixture.db
        .prepare('UPDATE session_rollups SET parent_session_id = ? WHERE session_id = ?')
        .run(h.fixture.store.findSession('codex', 'parent')!.id, child.id);
}

describe('live-memory retention eligibility', () => {
    it('skips open, recently active, consent-unsettled, and parent-referenced sessions', () => {
        const h = harness();
        seedIneligible(h);
        seedUnit(h, 'eligible', { startedAt: '2026-01-05T00:00:00.000Z' });
        const before = nativeSessions(h);
        const { store } = atCapacity(h, 1);

        store.recordIngestedTurn(currentTurn(h), {}, false, summary, true);

        expect(nativeSessions(h)).toEqual([...before.filter((id) => id !== 'codex:eligible'), 'codex:current'].sort());
    });

    it('defers the capture with a recorded gap when only ineligible sessions could reach the target', () => {
        const h = harness();
        seedIneligible(h);
        const before = nativeSessions(h);
        const { store, backups } = atCapacity(h, 1);

        expectDeferred(() => store.recordIngestedTurn(currentTurn(h), {}, false, summary, true), 'target_unreachable');

        expect(nativeSessions(h)).toEqual(before);
        expect(backups).toEqual([]);
        expect(readLiveMemoryRetentionReport(h.fixture.db, 10).deferrals).toEqual([
            expect.objectContaining({ tool: 'codex', native_id: 'current', reason: 'target_unreachable', attempts: 1 }),
        ]);
        expectLiveMemoryCurrent(h.fixture.db);
    });

    it('never cleans up for a write that jumps from below the warning band straight to capacity', () => {
        const h = harness();
        seedOrderingCorpus(h);
        const before = nativeSessions(h);
        const { store, backups } = atCapacity(h, 1, { warningBytes: readLiveMemoryUsage(h.fixture.db) + 1 });

        expectDeferred(() => store.recordIngestedTurn(currentTurn(h), {}, false, summary, true), 'unwarned_jump');

        expect(nativeSessions(h)).toEqual(before);
        expect(backups).toEqual([]);
    });

    it('refuses to remove anything when the running ledger disagrees with the stored rows', () => {
        const h = harness();
        seedOrderingCorpus(h);
        const before = nativeSessions(h);
        const { store, backups } = atCapacity(h, 1);
        h.fixture.db.prepare('UPDATE live_memory_usage SET total_bytes = total_bytes + 1 WHERE id = 1').run();

        expectDeferred(() => store.recordIngestedTurn(currentTurn(h), {}, false, summary, true), 'ledger_disagreement');

        expect(nativeSessions(h)).toEqual(before);
        expect(backups).toEqual([]);
    });
});

describe('live-memory retention failure safety', () => {
    it('keeps all memory when the backup fails, waits before retrying, then cleans up once a backup succeeds', () => {
        const h = harness();
        seedOrderingCorpus(h);
        const before = nativeSessions(h);
        let attempts = 0;
        let failing = true;
        const fallback = retentionStore(h).store.liveMemoryRetention.policy.backup;
        const { store, clock } = atCapacity(h, 1, {
            backup: (db, verify) => {
                attempts++;
                if (failing) {
                    throw new Error('disk full');
                }
                return fallback(db, verify);
            },
        });

        expectDeferred(() => store.recordIngestedTurn(currentTurn(h), {}, false, summary, true), 'backup_failed');
        expectDeferred(() => store.recordIngestedTurn(currentTurn(h), {}, false, summary, true), 'cleanup_retry_wait');
        expect(attempts).toBe(1);
        expect(nativeSessions(h)).toEqual(before);
        expect(readLiveMemoryRetentionReport(h.fixture.db, 10).state).toMatchObject({ outcome: 'failed', reason: 'backup_failed' });

        failing = false;
        clock.now += HOUR;
        expect(store.recordIngestedTurn(currentTurn(h), {}, false, summary, true)?.inserted).toBe(true);
        expect(attempts).toBe(2);
        expect(nativeSessions(h)).not.toContain('claude-code:claudez');
        expect(readLiveMemoryRetentionReport(h.fixture.db, 10).deferrals).toEqual([]);
    });

    it('rejects a backup that does not hold the planned rows', () => {
        const h = harness();
        seedOrderingCorpus(h);
        const before = nativeSessions(h);
        const { store } = atCapacity(h, 1, {
            backup: (db, verify) => {
                const backupPath = path.join(h.fixture.directory, 'short-backup.db');
                db.prepare('VACUUM INTO ?').run(backupPath);
                const copy = new Database(backupPath);
                copy.exec('DELETE FROM filtered_turns');
                copy.close();
                db.prepare('ATTACH DATABASE ? AS retention_copy').run(backupPath);
                try {
                    verify('retention_copy');
                } finally {
                    db.exec('DETACH DATABASE retention_copy');
                }
                return backupPath;
            },
        });

        expectDeferred(() => store.recordIngestedTurn(currentTurn(h), {}, false, summary, true), 'backup_failed');

        expect(nativeSessions(h)).toEqual(before);
    });

    it('aborts without removing anything when a planned session changes source generation before removal', () => {
        const h = harness();
        seedOrderingCorpus(h);
        const before = nativeSessions(h);
        const { store } = atCapacity(h, 1, {}, () => {
            h.fixture.db.prepare("UPDATE source_generations SET generation = 1 WHERE tool = 'claude-code' AND native_id = 'claudez'").run();
        });

        expectDeferred(() => store.recordIngestedTurn(currentTurn(h), {}, false, summary, true), 'revalidation_failed');

        expect(nativeSessions(h)).toEqual(before);
        expectLiveMemoryCurrent(h.fixture.db);
    });

    it('aborts without removing anything when consent for a planned session changes before removal', () => {
        const h = harness();
        seedOrderingCorpus(h);
        const before = nativeSessions(h);
        const { store } = atCapacity(h, 1, {}, () => {
            h.fixture.store.consent.revoke(h.victims.path);
        });

        expectDeferred(() => store.recordIngestedTurn(currentTurn(h), {}, false, summary, true), 'revalidation_failed');

        expect(nativeSessions(h)).toEqual(before);
    });

    it('rolls the removal and the write back together when the measured result misses the target', () => {
        const h = harness();
        seedOrderingCorpus(h);
        const before = nativeSessions(h);
        const usage = readLiveMemoryUsage(h.fixture.db);
        const { store } = atCapacity(h, unitBytes(h, 'claude-code', 'claudez'), {}, () => {
            // A concurrent write to a session outside the plan grows the total,
            // by less than the triggering write so the capacity guard admits it.
            h.fixture.db.prepare("UPDATE sessions SET custom_title = ? WHERE native_id = 'codexa'").run('t'.repeat(10));
        });

        expectDeferred(() => store.recordIngestedTurn(currentTurn(h), {}, false, summary, true), 'verification_failed');

        expect(nativeSessions(h)).toEqual(before);
        expect(readLiveMemoryUsage(h.fixture.db)).toBe(usage + 10);
        expect(h.fixture.db.prepare('SELECT COUNT(*) AS count FROM purged_transcripts').get()).toEqual({ count: 0 });
        expectLiveMemoryCurrent(h.fixture.db);
    });

    it('refuses cleanup with the production backup when the database is not encrypted', () => {
        const h = harness();
        seedOrderingCorpus(h);
        const before = nativeSessions(h);
        const { store } = atCapacity(h, 1, { backup: LIVE_MEMORY_RETENTION_POLICY.backup });

        expectDeferred(() => store.recordIngestedTurn(currentTurn(h), {}, false, summary, true), 'backup_failed');

        expect(nativeSessions(h)).toEqual(before);
    });

    it('writes a verified encrypted backup before removing from an encrypted database', () => {
        const scratch = createTestDb('elepha-retention-keyed-');
        scratch.close();
        const dbPath = path.join(scratch.directory, 'keyed.db');
        openKeyedDatabase(dbPath, FIXED_KEY).close();
        const db = openInitializedKeyedDatabase(dbPath, FIXED_KEY);
        const fixture: TestDatabase = {
            directory: scratch.directory,
            dbPath,
            db,
            store: new MemoryStore(db, { resolveGitRoot: () => null, resolveGitRemote: () => null }),
            close: () => db.close(),
        };
        const h = harness(fixture);
        seedOrderingCorpus(h);
        const { store } = atCapacity(h, 1, { backup: LIVE_MEMORY_RETENTION_POLICY.backup });

        store.recordIngestedTurn(currentTurn(h), {}, false, summary, true);

        const backupPath = readLiveMemoryRetentionReport(db, 10).state?.backup_path;
        expect(backupPath).toBeDefined();
        expect(readFileSync(backupPath!).subarray(0, 16).toString('binary')).not.toBe('SQLite format 3\0');
        const copy = openKeyedDatabase(backupPath!, FIXED_KEY, { readonly: true, fileMustExist: true });
        expect(copy.prepare("SELECT COUNT(*) AS count FROM sessions WHERE native_id = 'claudez'").get()).toEqual({ count: 1 });
        copy.close();
        expect(nativeSessions(h)).not.toContain('claude-code:claudez');
        db.close();
    });
});

describe('live-memory retention removal', () => {
    it('removes every derived row, leaves no stale search or vector hit, and preserves projects and rules', () => {
        const h = harness();
        seedOrderingCorpus(h);
        const victim = h.fixture.store.findSession('claude-code', 'claudez')!;
        const memory = h.fixture.db.prepare('SELECT id FROM memories WHERE session_id = ?').get(victim.id) as { id: number };
        const vector = Buffer.alloc(8, 1);
        seedRollup(h.fixture, { project: h.victims, session: victim });
        h.fixture.db
            .prepare(
                `INSERT INTO session_embeddings (session_id, project_id, source_hash, model, model_revision, dimensions, vector, computed_at)
                 VALUES (?, ?, 'h', 'm', 'r', 2, ?, ?)`,
            )
            .run(victim.id, h.victims.id, vector, OLD_INGEST);
        h.fixture.db
            .prepare(
                `INSERT INTO turn_embeddings (memory_id, project_id, source_digest, text_hash, model, model_revision, dimensions, vector, computed_at)
                 VALUES (?, ?, 'd', 't', 'm', 'r', 2, ?, ?)`,
            )
            .run(memory.id, h.victims.id, vector, OLD_INGEST);
        h.fixture.db
            .prepare(
                "INSERT INTO standing_rules (ulid, project_id, text, created_at) VALUES ('01JRULE0000000000000000000', ?, 'keep tests', ?)",
            )
            .run(h.victims.id, OLD_INGEST);
        h.fixture.db
            .prepare(
                `INSERT INTO session_rules (ulid, tool, native_session_id, checkout_anchor, owner_project_id, text, created_at)
                 VALUES ('01JCHAT0000000000000000000', 'claude-code', 'claudez', 'anchor', ?, 'chat rule', ?)`,
            )
            .run(h.victims.id, OLD_INGEST);
        const projects = h.fixture.db.prepare('SELECT * FROM projects ORDER BY id').all();
        const rules = [
            h.fixture.db.prepare('SELECT * FROM standing_rules').all(),
            h.fixture.db.prepare('SELECT * FROM session_rules').all(),
        ];
        const { store } = atCapacity(h, unitBytes(h, 'claude-code', 'claudez'));

        store.recordIngestedTurn(currentTurn(h), {}, false, summary, true);

        expect(nativeSessions(h)).not.toContain('claude-code:claudez');
        expect(h.fixture.db.prepare("SELECT rowid FROM filtered_turns_fts WHERE filtered_turns_fts MATCH 'needleclaudez'").all()).toEqual(
            [],
        );
        for (const [table, column, id] of [
            ['memories', 'id', memory.id],
            ['turn_search_index', 'memory_id', memory.id],
            ['turn_embeddings', 'memory_id', memory.id],
            ['session_embeddings', 'session_id', victim.id],
            ['session_rollups', 'session_id', victim.id],
            ['durable_capture_status', 'session_id', victim.id],
        ] as const) {
            expect(h.fixture.db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${column} = ?`).get(id)).toEqual({ count: 0 });
        }
        expect(
            h.fixture.db.prepare("SELECT rowid FROM filtered_turns_fts WHERE filtered_turns_fts MATCH 'needlecodexb'").all(),
        ).toHaveLength(1);
        expect(h.fixture.db.prepare('SELECT * FROM projects ORDER BY id').all()).toEqual(expect.arrayContaining(projects));
        expect([
            h.fixture.db.prepare('SELECT * FROM standing_rules').all(),
            h.fixture.db.prepare('SELECT * FROM session_rules').all(),
        ]).toEqual(rules);
        expectLiveMemoryCurrent(h.fixture.db);
    });

    it('never recreates a removed session from live capture, a restarted daemon, or a reopened database', async () => {
        const h = harness();
        seedOrderingCorpus(h);
        const { store } = atCapacity(h, unitBytes(h, 'claude-code', 'claudez'));
        store.recordIngestedTurn(currentTurn(h), {}, false, summary, true);
        expect(nativeSessions(h)).not.toContain('claude-code:claudez');
        const resurrect = parsed('claude-code', 'claudez', h.victims.path, 0, '2026-01-01T00:00:00.000Z', 'needleclaudez again');

        expect(h.fixture.store.recordIngestedTurn(resurrect, {}, false, summary, true)).toBeUndefined();
        h.fixture.close();
        const reopened = openUnmanagedDb(h.fixture.dbPath);
        const reopenedStore = new MemoryStore(reopened, { resolveGitRoot: () => null, resolveGitRemote: () => null });
        expect(reopenedStore.recordIngestedTurn(resurrect, {}, false, summary, true)).toBeUndefined();
        const daemon = new IngestionDaemon({
            store: reopenedStore,
            adapters: [adapterFor('claude-code')],
            watchRoots: [],
            readConfig: () => ({ config: { ...DEFAULT_MEMORY_CONFIG, durableCapture: true } }),
        }) as unknown as { persistTurn(adapter: SessionAdapter, turn: ParsedTurn): Promise<boolean> };
        await expect(daemon.persistTurn(adapterFor('claude-code'), resurrect)).resolves.toBe(false);
        expect(reopened.prepare("SELECT COUNT(*) AS count FROM sessions WHERE native_id = 'claudez'").get()).toEqual({ count: 0 });
        expect(readLiveMemoryRetentionReport(reopened, 10).recentRemovals).toEqual([expect.objectContaining({ native_id: 'claudez' })]);
        reopened.close();
    });
});

function adapterFor(tool: ToolName): SessionAdapter {
    return {
        tool,
        watchGlobs: ['*.jsonl'],
        matches: () => true,
        nativeSessionId: (filePath) => path.basename(filePath, '.jsonl'),
        classifySession: async () => ({ kind: 'primary' }),
        classifyEmptySession: async () => undefined,
        async *parseTurns() {},
    } as SessionAdapter;
}

describe('live-memory retention write entry points', () => {
    // Nothing is eligible (every session is inside the active window), so any
    // writer that reached an old per-copy eviction would remove a copy here.
    function fullHarness(seed?: (h: Harness) => void) {
        const h = harness();
        seedUnit(h, 'codexa');
        seedUnit(h, 'codexb');
        seed?.(h);
        const copies = h.fixture.db.prepare('SELECT memory_id, user_prompt FROM filtered_turns ORDER BY memory_id').all();
        // No retry wait, so every writer runs the full cleanup attempt.
        const { store } = retentionStore(h, { capacityBytes: 1, targetBytes: 0, activeWindowMs: Number.MAX_SAFE_INTEGER, retryMs: 0 });
        const unchanged = () => {
            expect(h.fixture.db.prepare('SELECT memory_id, user_prompt FROM filtered_turns ORDER BY memory_id').all()).toEqual(copies);
            expect(h.fixture.db.prepare("SELECT COUNT(*) AS count FROM durable_capture_status WHERE state = 'evicted'").get()).toEqual({
                count: 0,
            });
        };
        return { h, store, unchanged };
    }

    it('defers live ingestion, direct turn recording, and reingest instead of evicting copies', () => {
        const { h, store, unchanged } = fullHarness();
        const session = h.fixture.store.findSession('codex', 'codexa')!;

        expectDeferred(() => store.recordIngestedTurn(currentTurn(h), {}, false, summary, true), 'target_unreachable');
        expectDeferred(
            () =>
                store.recordTurn(
                    parsed('codex', 'codexa', h.victims.path, 1, OLD_INGEST, 'more'),
                    session.id,
                    session.project_id,
                    summary,
                    true,
                ),
            'target_unreachable',
        );
        expectDeferred(
            () =>
                store.reingestTurn(
                    parsed('codex', 'codexa', h.victims.path, 0, '2026-01-01T00:00:00.000Z', 'rewritten'),
                    session.id,
                    session.project_id,
                    summary,
                    false,
                    true,
                ),
            'target_unreachable',
        );
        unchanged();
        expect(h.fixture.store.findSession('codex', 'current')).toBeUndefined();
        expect(h.fixture.db.prepare('SELECT COUNT(*) AS count FROM memories WHERE session_id = ?').get(session.id)).toEqual({ count: 1 });
    });

    // Codex copies are automatic, so the legacy setting must not change the deferral.
    it.each([true, false])('defers a daemon capture without advancing its cursor; legacy durable-capture=%s', async (durableCapture) => {
        const { h, store, unchanged } = fullHarness();
        const session = h.fixture.store.findSession('codex', 'codexa')!;
        const daemon = new IngestionDaemon({
            store,
            adapters: [adapterFor('codex')],
            watchRoots: [],
            readConfig: () => ({ config: { ...DEFAULT_MEMORY_CONFIG, durableCapture } }),
        }) as unknown as { persistTurn(adapter: SessionAdapter, turn: ParsedTurn): Promise<boolean> };

        await expect(
            daemon.persistTurn(adapterFor('codex'), parsed('codex', 'codexa', h.victims.path, 1, OLD_INGEST, 'next turn')),
        ).rejects.toBeInstanceOf(LiveMemoryCaptureDeferredError);

        unchanged();
        expect(h.fixture.store.getSessionCursor('codex', 'codexa')).toBe(session.cursor);
    });

    it('clears the recorded gap once the deferred chat is captured', () => {
        const h = harness();
        seedIneligible(h);
        const { store } = atCapacity(h, 1);
        expectDeferred(() => store.recordIngestedTurn(currentTurn(h), {}, false, summary, true), 'target_unreachable');
        expect(readLiveMemoryRetentionReport(h.fixture.db, 10).deferrals).toHaveLength(1);
        retentionStore(h);

        expect(h.fixture.store.recordIngestedTurn(currentTurn(h), {}, false, summary, true)?.inserted).toBe(true);

        expect(readLiveMemoryRetentionReport(h.fixture.db, 10).deferrals).toEqual([]);
    });
});

describe('live-memory retention unit completeness and order', () => {
    it('never selects a session with an incomplete or unknown segment capture state or an unknown source generation', () => {
        const h = harness();
        const setState = (nativeId: string, state: string | null, segment?: number) => {
            const where = segment === undefined ? '' : ` AND segment_index = ${segment}`;
            const ids = `SELECT id FROM sessions WHERE native_id = '${nativeId}'${where}`;
            if (state === null) {
                h.fixture.db.exec(`DELETE FROM durable_capture_status WHERE session_id IN (${ids})`);
            } else {
                h.fixture.db.prepare(`UPDATE durable_capture_status SET state = ? WHERE session_id IN (${ids})`).run(state);
            }
        };
        for (const state of ['disabled_gap', 'parse_error', 'evicted', 'revoked', 'incognito']) {
            seedUnit(h, `state${state.replace('_', '')}`);
            setState(`state${state.replace('_', '')}`, state);
        }
        seedUnit(h, 'nostatus');
        setState('nostatus', null);
        seedUnit(h, 'halfcomplete', { segments: 2 });
        setState('halfcomplete', 'disabled_gap', 1);
        seedUnit(h, 'nogeneration');
        h.fixture.db.prepare("DELETE FROM source_generations WHERE native_id = 'nogeneration'").run();
        seedUnit(h, 'truncated', { startedAt: '2026-01-04T00:00:00.000Z' });
        setState('truncated', 'complete_truncated');
        seedUnit(h, 'complete', { startedAt: '2026-01-05T00:00:00.000Z' });
        const before = nativeSessions(h);
        const { store } = atCapacity(h, unitBytes(h, 'codex', 'truncated') + 1);

        store.recordIngestedTurn(currentTurn(h), {}, false, summary, true);

        expect(nativeSessions(h)).toEqual(
            [...before.filter((id) => id !== 'codex:truncated' && id !== 'codex:complete'), 'codex:current'].sort(),
        );
    });

    it('orders by the earliest session start across segments, never by the first turn time', () => {
        const h = harness();
        // Earliest first turn, but the latest session start.
        seedUnit(h, 'earlyturn', { startedAt: '2026-01-05T00:00:00.000Z', turnStartedAt: '2025-01-01T00:00:00.000Z' });
        seedUnit(h, 'split', { startedAt: '2026-01-09T00:00:00.000Z', segments: 2 });
        h.fixture.db
            .prepare("UPDATE sessions SET started_at = '2026-01-02T00:00:00.000Z' WHERE native_id = 'split' AND segment_index = 1")
            .run();
        seedUnit(h, 'middle', { startedAt: '2026-01-03T00:00:00.000Z' });
        const { store } = atCapacity(h, unitBytes(h, 'codex', 'split') + 1);

        store.recordIngestedTurn(currentTurn(h), {}, false, summary, true);

        expect(nativeSessions(h)).toEqual(['codex:current', 'codex:earlyturn']);
        expect(readLiveMemoryRetentionReport(h.fixture.db, 10).recentRemovals).toContainEqual(
            expect.objectContaining({ native_id: 'split', source_started_at: '2026-01-02T00:00:00.000Z' }),
        );
    });
});

describe('live-memory retention for secondary writers', () => {
    it('cleans up for a rollup write that reaches capacity', () => {
        const h = harness();
        seedOrderingCorpus(h);
        const session = h.fixture.store.findSession('codex', 'codexa')!;
        const rollup = () =>
            seedRollup(h.fixture, { project: h.victims, session, decisions: [{ what: 'r'.repeat(500), why: 'rollup reason' }] });
        const usage = readLiveMemoryUsage(h.fixture.db);
        const write = measureWrite(h, rollup);
        retentionStore(h, { capacityBytes: usage + write, targetBytes: usage + write - unitBytes(h, 'claude-code', 'claudez') });

        rollup();

        expect(h.fixture.db.prepare('SELECT COUNT(*) AS count FROM session_rollups WHERE session_id = ?').get(session.id)).toEqual({
            count: 1,
        });
        expect(nativeSessions(h)).not.toContain('claude-code:claudez');
        expect(readLiveMemoryUsage(h.fixture.db)).toBeLessThan(usage + write);
        expectLiveMemoryCurrent(h.fixture.db);
    });

    it('refuses a backfill batch that would reach capacity and commits none of it', async () => {
        const h = harness();
        seedOrderingCorpus(h);
        const titles = () => h.fixture.db.prepare('SELECT native_id, custom_title FROM sessions ORDER BY id').all();
        const before = titles();
        retentionStore(h, { capacityBytes: readLiveMemoryUsage(h.fixture.db) + 150 });
        const deriver: BackfillDeriver<{ id: number }, { sessionId: number; transcriptMissing: boolean }> = {
            load: (db: Database.Database) => ({
                sessions: db.prepare('SELECT id FROM sessions ORDER BY id').all() as Array<{ id: number }>,
                state: undefined,
            }),
            derive: async ({ session }) => ({ sessionId: session.id, transcriptMissing: false }),
            shouldWrite: () => true,
            write: (db, change) => {
                db.prepare('UPDATE sessions SET custom_title = ? WHERE id = ?').run('t'.repeat(80), change.sessionId);
                return {};
            },
        };

        const refused = await applyBackfill(h.fixture.db, {} as never, deriver).catch((error: unknown) => error);

        expect(isLiveMemoryCapacityGuardError(refused)).toBe(true);
        expect(titles()).toEqual(before);
    });

    it('refuses any other write that would raise the total to capacity, but never blocks one that shrinks it', () => {
        const h = harness();
        seedOrderingCorpus(h);
        retentionStore(h, { capacityBytes: readLiveMemoryUsage(h.fixture.db) + 50 });
        const grow = () => h.fixture.db.prepare("UPDATE sessions SET custom_title = ? WHERE native_id = 'codexa'").run('g'.repeat(100));

        expect(grow).toThrow();
        let caught: unknown;
        try {
            grow();
        } catch (error) {
            caught = error;
        }
        expect(isLiveMemoryCapacityGuardError(caught)).toBe(true);
        expect(h.fixture.db.prepare("SELECT custom_title FROM sessions WHERE native_id = 'codexa'").get()).toEqual({ custom_title: null });
        expect(() =>
            h.fixture.db
                .prepare(
                    "DELETE FROM filtered_turns WHERE memory_id IN (SELECT m.id FROM memories m JOIN sessions s ON s.id = m.session_id WHERE s.native_id = 'codexa')",
                )
                .run(),
        ).not.toThrow();
        expectLiveMemoryCurrent(h.fixture.db);
    });
});

describe('live-memory retention confirmation and daemon deferral', () => {
    afterEach(() => vi.unstubAllEnvs());

    it('reports an error with the recovery backup when the post-commit confirmation fails', () => {
        const h = harness();
        seedOrderingCorpus(h);
        const { store } = atCapacity(h, unitBytes(h, 'claude-code', 'claudez'), {
            afterCleanupCommit: () => {
                // Something outside the policy recreates a removed session row.
                h.fixture.db
                    .prepare(
                        `INSERT INTO sessions (tool, native_id, segment_index, project_id, source_path, started_at, last_ingested_at)
                         VALUES ('claude-code', 'claudez', 0, ?, 'x', ?, ?)`,
                    )
                    .run(h.victims.id, OLD_INGEST, OLD_INGEST);
            },
        });

        let caught: unknown;
        try {
            store.recordIngestedTurn(currentTurn(h), {}, false, summary, true);
        } catch (error) {
            caught = error;
        }

        expect(caught).toBeInstanceOf(LiveMemoryRetentionVerificationError);
        const state = readLiveMemoryRetentionReport(h.fixture.db, 10).state;
        expect(state).toMatchObject({ outcome: 'unconfirmed' });
        expect(state?.backup_path).toBe((caught as LiveMemoryRetentionVerificationError).backupPath);
        expect(readFileSync(state!.backup_path!).length).toBeGreaterThan(0);
    });

    it('defers a scanned transcript at capacity without advancing its cursor, then captures it once there is room', async () => {
        const h = harness();
        seedUnit(h, 'recent', { lastIngestedAt: new Date(NOW).toISOString() });
        const codexHome = path.join(h.fixture.directory, 'codex-home');
        const sessionsRoot = path.join(codexHome, 'sessions');
        mkdirSync(sessionsRoot, { recursive: true });
        vi.stubEnv('CODEX_HOME', codexHome);
        const transcript = path.join(sessionsRoot, 'scanned.jsonl');
        writeFileSync(transcript, `${JSON.stringify({ cwd: h.currentPath })}\n`);
        const adapter: SessionAdapter = {
            ...adapterFor('codex'),
            async *parseTurns(filePath: string) {
                yield { ...parsed('codex', 'scanned', h.currentPath, 0, OLD_INGEST, 'first scanned turn'), sourcePath: filePath };
            },
        } as SessionAdapter;
        const daemon = new IngestionDaemon({
            store: h.fixture.store,
            adapters: [adapter],
            watchRoots: [sessionsRoot],
            readConfig: () => ({ config: { ...DEFAULT_MEMORY_CONFIG, durableCapture: true } }),
        }) as unknown as {
            scanFile(
                adapter: SessionAdapter,
                filePath: string,
                closeTrailingOnIdle: boolean,
            ): Promise<{ ingested: number; skipped?: { category: string } }>;
        };
        retentionStore(h, { capacityBytes: 1, targetBytes: 0, activeWindowMs: Number.MAX_SAFE_INTEGER });

        await expect(daemon.scanFile(adapter, transcript, true)).resolves.toMatchObject({
            ingested: 0,
            skipped: { category: 'capacity deferred' },
        });
        expect(h.fixture.store.findSession('codex', 'scanned')).toBeUndefined();
        expect(readLiveMemoryRetentionReport(h.fixture.db, 10).deferrals).toEqual([
            expect.objectContaining({ native_id: 'scanned', reason: 'target_unreachable' }),
        ]);

        retentionStore(h);
        await expect(daemon.scanFile(adapter, transcript, true)).resolves.toMatchObject({ ingested: 1 });
        expect(h.fixture.store.getSessionCursor('codex', 'scanned')).toBe('1');
        expect(readLiveMemoryRetentionReport(h.fixture.db, 10).deferrals).toEqual([]);
    });
});
