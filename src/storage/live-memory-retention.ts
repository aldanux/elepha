// Fixed live-memory retention: the only automatic deletion elepha performs.
//
// Every capture write runs through LiveMemoryRetention.run. Below capacity the
// write commits untouched and nothing is deleted. When the write would leave
// the ledger at or above capacity it is rolled back and cleanup removes whole
// native sessions (every segment and every derived row, never one turn or one
// copy), oldest source start first, taking the smallest prefix that brings
// the total including the write to the target. The order of operations is
// what keeps a failure from losing anything:
//
//   1. Plan inside one read snapshot, after remeasuring the stored rows and
//      requiring the running ledger to agree with them.
//   2. Write an encrypted backup and verify it holds every planned row.
//   3. In one immediate write transaction: revalidate each frozen unit, replay
//      the write, delete the units and record their removal, and verify the
//      measured result reaches the target.
//   4. After commit, confirm the removed rows are gone and the ledger agrees.
//
// Nothing commits before step 3, and any failure inside step 3 rolls the whole
// transaction back. Either way the triggering capture is deferred with a
// recorded coverage gap; there is no fallback that removes anything else.
// The removal record is the automatic no-resurrection marker: capture,
// backfill, reingest and serving refuse a removed native session. It is kept
// apart from the user's permanent purge tombstones, so restoring a backup
// taken before the cleanup brings the removed evidence back, while purge and
// incognito decisions keep their protection.

import type { Database, Statement } from 'better-sqlite3-multiple-ciphers';
import type { DurableCaptureState } from '../config/constants.js';
import {
    LIVE_MEMORY_ACTIVE_WINDOW_MS,
    LIVE_MEMORY_CAPACITY_BYTES,
    LIVE_MEMORY_CLEANUP_RETRY_MS,
    LIVE_MEMORY_CLEANUP_TARGET_BYTES,
    LIVE_MEMORY_WARNING_BYTES,
} from '../config/live-memory-retention.js';
import type { ToolName } from '../types/index.js';
import { errorMessage } from '../util/error.js';
import { writeVerifiedEncryptedBackup } from './backup.js';
import { type ConsentState, ConsentStore } from './consent-store.js';
import { setLiveMemoryCapacityGuard, withLiveMemoryCapacityGuardBypassed } from './live-memory-capacity-guard.js';
import {
    LIVE_MEMORY_CAPTURE_DEFERRALS_TABLE,
    LIVE_MEMORY_RETENTION_REMOVALS_TABLE,
    LIVE_MEMORY_RETENTION_STATE_TABLE,
} from './live-memory-retention-schema.js';
import {
    measureLiveMemoryByNativeSession,
    measureLiveMemoryBytes,
    type NativeSessionLiveMemory,
    nativeSessionKey,
    readLiveMemoryUsage,
} from './live-memory-usage.js';

export const LIVE_MEMORY_DEFERRAL_REASONS = [
    // The write jumped from below the warning band straight to capacity, so no
    // warning can have preceded a cleanup.
    'unwarned_jump',
    // A recent cleanup attempt failed; retrying on every write would stall capture.
    'cleanup_retry_wait',
    // The caller holds a transaction, inside which no backup can be taken.
    'transaction_open',
    'ledger_disagreement',
    'target_unreachable',
    'backup_failed',
    'revalidation_failed',
    'verification_failed',
] as const;
export type LiveMemoryDeferralReason = (typeof LIVE_MEMORY_DEFERRAL_REASONS)[number];

export interface LiveMemoryRetentionPolicy {
    capacityBytes: number;
    targetBytes: number;
    warningBytes: number;
    activeWindowMs: number;
    retryMs: number;
    now: () => number;
    // Writes a recoverable encrypted backup of the whole database, passes the
    // attached copy's schema to verify, and returns the backup path.
    backup: (db: Database, verify: (schema: string) => void) => string;
    // Test seam: runs between the cleanup commit and its confirmation.
    afterCleanupCommit?: () => void;
}

// Tests substitute small thresholds and failing backups instead of allocating
// gigabytes; production always uses exactly these values.
export const LIVE_MEMORY_RETENTION_POLICY: Readonly<LiveMemoryRetentionPolicy> = {
    capacityBytes: LIVE_MEMORY_CAPACITY_BYTES,
    targetBytes: LIVE_MEMORY_CLEANUP_TARGET_BYTES,
    warningBytes: LIVE_MEMORY_WARNING_BYTES,
    activeWindowMs: LIVE_MEMORY_ACTIVE_WINDOW_MS,
    retryMs: LIVE_MEMORY_CLEANUP_RETRY_MS,
    now: Date.now,
    backup: (db, verify) => writeVerifiedEncryptedBackup(db, verify),
};

export interface LiveMemoryCaptureIdentity {
    tool: ToolName;
    nativeId: string;
}

// The triggering capture was not written. Its gap is recorded durably and the
// caller must leave the source position unadvanced so a later pass retries.
export class LiveMemoryCaptureDeferredError extends Error {
    constructor(
        readonly identity: LiveMemoryCaptureIdentity,
        readonly reason: LiveMemoryDeferralReason,
        readonly detail?: string,
    ) {
        super(`live-memory capacity reached; capture deferred (${reason}${detail === undefined ? '' : `: ${detail}`})`);
        this.name = 'LiveMemoryCaptureDeferredError';
    }
}

// The cleanup and the triggering write committed, but the post-commit
// confirmation failed. The backup taken before the commit is the recovery source.
export class LiveMemoryRetentionVerificationError extends Error {
    constructor(
        readonly backupPath: string,
        detail: string,
    ) {
        super(`live-memory cleanup could not be confirmed after commit (${detail}); recovery backup: ${backupPath}`);
        this.name = 'LiveMemoryRetentionVerificationError';
    }
}

type IneligibleReason = 'active_writer' | 'open_turn' | 'capture_incomplete' | 'consent_unsettled' | 'identity_uncertain';

// Only a segment whose durable copy is known complete can be removed as part
// of a complete unit; every other state, or no state at all, is uncertain.
const COMPLETE_CAPTURE_STATES: ReadonlySet<DurableCaptureState> = new Set(['complete', 'complete_truncated']);

interface UnitSession {
    id: number;
    segment: number;
    projectId: number;
    projectPath: string | null;
    lastIngestedAt: string;
    startedAt: string;
    captureState: string | null;
}

// One native session across all of its segments: the unit cleanup removes.
interface RetentionUnit {
    tool: string;
    nativeId: string;
    sessions: UnitSession[];
    // Earliest valid source turn time; null sorts after every valid time.
    startMs: number | null;
    startedAt: string | null;
    // Null when no source-generation record exists, which is not generation 0.
    generation: number | null;
    consent: Array<[string, ConsentState]>;
    tables: NativeSessionLiveMemory['tables'];
    bytes: number;
    memoryIds?: number[];
    ineligible?: IneligibleReason;
}

interface RetentionPlan {
    units: RetentionUnit[];
    identitiesJson: string;
    memoryIdsJson: string;
    sessionIdsJson: string;
}

class RetentionAbort extends Error {
    constructor(
        readonly reason: LiveMemoryDeferralReason,
        detail: string,
    ) {
        super(detail);
    }
}

const ROLLED_BACK_PROBE = Symbol('live-memory probe rolled back');

// A session start must look like an ISO-8601 timestamp before SQLite parses
// it; julianday() alone would read a bare number as a Julian day.
const VALID_START = `s.started_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*' AND julianday(s.started_at) IS NOT NULL`;
const START_MS = `CAST(ROUND((julianday(s.started_at) - 2440587.5) * 86400000.0) AS INTEGER)`;

function scopeClause(identitiesJson: string | undefined, tool: string, nativeId: string, keyword: 'WHERE' | 'AND'): string {
    return identitiesJson === undefined
        ? ''
        : `${keyword} EXISTS (SELECT 1 FROM json_each(?) j WHERE json_extract(j.value, '$[0]') = ${tool} AND json_extract(j.value, '$[1]') = ${nativeId})`;
}

function scopedAll(db: Database, sql: string, identitiesJson: string | undefined): unknown[] {
    const statement = db.prepare(sql);
    return identitiesJson === undefined ? statement.all() : statement.all(identitiesJson);
}

function compareText(a: string, b: string): number {
    return a < b ? -1 : a > b ? 1 : 0;
}

// Valid start times first, oldest first; then the stable (tool, native_id)
// identity, which alone orders units with no valid start time.
function compareUnits(a: RetentionUnit, b: RetentionUnit): number {
    if (a.startMs !== null && b.startMs !== null && a.startMs !== b.startMs) {
        return a.startMs - b.startMs;
    }
    if ((a.startMs === null) !== (b.startMs === null)) {
        return a.startMs === null ? 1 : -1;
    }
    return compareText(a.tool, b.tool) || compareText(a.nativeId, b.nativeId);
}

const registered = new WeakMap<Database, LiveMemoryRetention>();

// Runs a write owned by one stored session under the connection's shared
// policy. A session that no longer exists owns nothing to measure, so its
// write runs as is and its own guards decide.
export function runSessionLiveMemoryWrite<T>(db: Database, sessionId: number, write: () => T): T {
    const identity = db.prepare('SELECT tool, native_id FROM sessions WHERE id = ?').get(sessionId) as
        | { tool: ToolName; native_id: string }
        | undefined;
    return identity === undefined ? write() : liveMemoryRetentionFor(db).run({ tool: identity.tool, nativeId: identity.native_id }, write);
}

// The one policy every writer on a connection shares.
export function liveMemoryRetentionFor(db: Database): LiveMemoryRetention {
    let retention = registered.get(db);
    if (retention === undefined) {
        retention = new LiveMemoryRetention(db);
        registered.set(db, retention);
    }
    return retention;
}

// Test seam: replaces the connection's policy and lowers its capacity guard to
// match, so isolated tests exercise the thresholds without allocating gigabytes.
export function useLiveMemoryRetentionPolicy(db: Database, policy: Readonly<LiveMemoryRetentionPolicy>): LiveMemoryRetention {
    const retention = new LiveMemoryRetention(db, policy);
    registered.set(db, retention);
    setLiveMemoryCapacityGuard(db, policy.capacityBytes);
    return retention;
}

export class LiveMemoryRetention {
    private readonly consent: ConsentStore;
    private readonly clearDeferral: Statement;

    constructor(
        private readonly db: Database,
        readonly policy: Readonly<LiveMemoryRetentionPolicy> = LIVE_MEMORY_RETENTION_POLICY,
    ) {
        this.consent = new ConsentStore(db);
        this.clearDeferral = db.prepare(`DELETE FROM ${LIVE_MEMORY_CAPTURE_DEFERRALS_TABLE} WHERE tool = ? AND native_id = ?`);
    }

    run<T>(identity: LiveMemoryCaptureIdentity, write: () => T): T {
        let over: { before: number; after: number } | undefined;
        try {
            return withLiveMemoryCapacityGuardBypassed(this.db, () => {
                const before = readLiveMemoryUsage(this.db);
                const value = write();
                const after = readLiveMemoryUsage(this.db);
                if (after >= this.policy.capacityBytes) {
                    over = { before, after };
                    throw ROLLED_BACK_PROBE;
                }
                this.clearDeferral.run(identity.tool, identity.nativeId);
                return value;
            });
        } catch (error) {
            if (error !== ROLLED_BACK_PROBE || over === undefined) {
                throw error;
            }
        }
        return this.cleanupAndWrite(identity, write, over.before, over.after);
    }

    private cleanupAndWrite<T>(identity: LiveMemoryCaptureIdentity, write: () => T, before: number, after: number): T {
        if (before < this.policy.warningBytes) {
            throw this.deferral(identity, 'unwarned_jump', `${before} -> ${after} bytes`, false);
        }
        if (this.db.inTransaction) {
            throw this.deferral(identity, 'transaction_open', undefined, false);
        }
        const retryAfter = this.db.prepare(`SELECT retry_after_ms, reason FROM ${LIVE_MEMORY_RETENTION_STATE_TABLE} WHERE id = 1`).get() as
            | { retry_after_ms: number; reason: string | null }
            | undefined;
        if (retryAfter !== undefined && retryAfter.retry_after_ms > this.policy.now()) {
            throw this.deferral(identity, 'cleanup_retry_wait', retryAfter.reason ?? undefined, false);
        }

        const planned = this.plan(identity, after - before);
        if (planned instanceof RetentionAbort) {
            throw this.deferral(identity, planned.reason, planned.message, true);
        }
        let backupPath: string;
        try {
            backupPath = this.policy.backup(this.db, (schema) => this.verifyBackup(planned, schema));
        } catch (error) {
            throw this.deferral(identity, 'backup_failed', errorMessage(error), true);
        }

        let outcome: { value: T; removed: boolean };
        try {
            outcome = this.db
                .transaction(() => withLiveMemoryCapacityGuardBypassed(this.db, () => this.decisive(identity, write, planned, backupPath)))
                .immediate();
        } catch (error) {
            if (error instanceof RetentionAbort) {
                throw this.deferral(identity, error.reason, error.message, true);
            }
            throw error;
        }
        if (outcome.removed) {
            this.policy.afterCleanupCommit?.();
            this.confirm(planned, backupPath);
        }
        return outcome.value;
    }

    // Selects the smallest oldest-first prefix of eligible units that brings
    // the remeasured total plus this write to the target, inside one snapshot.
    private plan(identity: LiveMemoryCaptureIdentity, writeBytes: number): RetentionPlan | RetentionAbort {
        return this.db.transaction((): RetentionPlan | RetentionAbort => {
            const ledger = readLiveMemoryUsage(this.db);
            const measured = measureLiveMemoryBytes(this.db);
            if (ledger !== measured) {
                return new RetentionAbort('ledger_disagreement', `ledger ${ledger} bytes, stored rows ${measured} bytes`);
            }
            const required = measured + writeBytes - this.policy.targetBytes;
            const selected: RetentionUnit[] = [];
            let freed = 0;
            for (const unit of [...this.describe(identity).values()].sort(compareUnits)) {
                if (freed >= required) {
                    break;
                }
                if (unit.ineligible === undefined) {
                    selected.push(unit);
                    freed += unit.bytes;
                }
            }
            if (freed < required) {
                return new RetentionAbort('target_unreachable', `eligible sessions hold ${freed} of the ${required} bytes required`);
            }
            const identitiesJson = JSON.stringify(selected.map((unit) => [unit.tool, unit.nativeId]));
            const memoryIds = this.memoryIds(identitiesJson);
            for (const unit of selected) {
                unit.memoryIds = memoryIds.get(nativeSessionKey(unit.tool, unit.nativeId)) ?? [];
            }
            return {
                units: selected,
                identitiesJson,
                memoryIdsJson: JSON.stringify(selected.flatMap((unit) => unit.memoryIds ?? [])),
                sessionIdsJson: JSON.stringify(selected.flatMap((unit) => unit.sessions.map((session) => session.id))),
            };
        })();
    }

    // The backup must hold every row the plan removes, exactly as planned.
    private verifyBackup(plan: RetentionPlan, schema: string): void {
        const copied = measureLiveMemoryByNativeSession(this.db, plan.identitiesJson, schema);
        for (const unit of plan.units) {
            const copy = copied.get(nativeSessionKey(unit.tool, unit.nativeId));
            if (copy === undefined || JSON.stringify(copy.tables) !== JSON.stringify(unit.tables)) {
                throw new Error(`backup does not hold the planned rows of a ${unit.tool} session`);
            }
        }
    }

    private decisive<T>(identity: LiveMemoryCaptureIdentity, write: () => T, plan: RetentionPlan, backupPath: string) {
        const current = this.describe(identity, plan.identitiesJson);
        const memoryIds = this.memoryIds(plan.identitiesJson);
        for (const unit of plan.units) {
            const key = nativeSessionKey(unit.tool, unit.nativeId);
            const now = current.get(key);
            if (now !== undefined) {
                now.memoryIds = memoryIds.get(key) ?? [];
            }
            if (now === undefined || JSON.stringify(now) !== JSON.stringify(unit)) {
                throw new RetentionAbort('revalidation_failed', `a planned ${unit.tool} session changed before removal`);
            }
        }

        const value = write();
        // Another writer may have freed space since the plan; a write that now
        // fits commits without removing anything.
        if (readLiveMemoryUsage(this.db) < this.policy.capacityBytes) {
            this.clearDeferral.run(identity.tool, identity.nativeId);
            return { value, removed: false };
        }

        const removedAt = new Date(this.policy.now()).toISOString();
        this.removeUnits(plan, removedAt, backupPath);
        const remaining = this.remainingRows(plan);
        if (remaining > 0) {
            throw new RetentionAbort('verification_failed', `${remaining} planned row(s) remained after removal`);
        }
        const measured = measureLiveMemoryBytes(this.db);
        const ledger = readLiveMemoryUsage(this.db);
        if (measured !== ledger) {
            throw new RetentionAbort(
                'verification_failed',
                `after removal the ledger holds ${ledger} bytes, stored rows ${measured} bytes`,
            );
        }
        if (measured > this.policy.targetBytes) {
            throw new RetentionAbort(
                'verification_failed',
                `after removal ${measured} bytes remain, above the ${this.policy.targetBytes} byte target`,
            );
        }
        this.clearDeferral.run(identity.tool, identity.nativeId);
        this.recordState('removed', null, removedAt, 0, backupPath);
        return { value, removed: true };
    }

    // Mirrors purge's explicit order. Filtered copies are deleted directly so
    // their FTS delete trigger runs, which SQLite does not reliably do for a
    // foreign-key cascade; memory deletion cascades to the turn search index,
    // turn vectors and task-state manifests, and session deletion to session
    // vectors, open turns and receipts. Projects, consent, standing rules,
    // source generations and MCP receipts are kept: the last two are control
    // records a restored backup needs to stay consistent with.
    private removeUnits(plan: RetentionPlan, removedAt: string, backupPath: string): void {
        const deleteRollup = this.db.prepare('DELETE FROM session_rollups WHERE session_id = ?');
        const deleteFilteredTurns = this.db.prepare(
            'DELETE FROM filtered_turns WHERE memory_id IN (SELECT id FROM memories WHERE session_id = ?)',
        );
        const deleteCaptureStatus = this.db.prepare('DELETE FROM durable_capture_status WHERE session_id = ?');
        const deleteMemories = this.db.prepare('DELETE FROM memories WHERE session_id = ?');
        const deleteSession = this.db.prepare('DELETE FROM sessions WHERE id = ?');
        const recordRemoval = this.db.prepare(
            `INSERT INTO ${LIVE_MEMORY_RETENTION_REMOVALS_TABLE}
             (tool, native_id, source_started_at, segments, removed_bytes, removed_at, backup_path)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (tool, native_id) DO UPDATE SET
               source_started_at = excluded.source_started_at,
               segments = excluded.segments,
               removed_bytes = excluded.removed_bytes,
               removed_at = excluded.removed_at,
               backup_path = excluded.backup_path`,
        );
        for (const unit of plan.units) {
            for (const session of unit.sessions) {
                deleteRollup.run(session.id);
            }
            for (const session of unit.sessions) {
                deleteFilteredTurns.run(session.id);
                deleteCaptureStatus.run(session.id);
                deleteMemories.run(session.id);
                deleteSession.run(session.id);
            }
            this.clearDeferral.run(unit.tool, unit.nativeId);
            recordRemoval.run(unit.tool, unit.nativeId, unit.startedAt, unit.sessions.length, unit.bytes, removedAt, backupPath);
        }
    }

    private remainingRows(plan: RetentionPlan): number {
        const byMemory = ['memories', 'filtered_turns', 'turn_search_index', 'turn_embeddings', 'task_state_manifests'].map(
            (table) =>
                `(SELECT COUNT(*) FROM ${table} WHERE ${table === 'memories' ? 'id' : 'memory_id'} IN (SELECT value FROM json_each(@memories)))`,
        );
        const bySession = ['sessions', 'session_rollups', 'session_embeddings', 'open_turns', 'durable_capture_status'].map(
            (table) =>
                `(SELECT COUNT(*) FROM ${table} WHERE ${table === 'sessions' ? 'id' : 'session_id'} IN (SELECT value FROM json_each(@sessions)))`,
        );
        const identities = `(SELECT COUNT(*) FROM sessions s WHERE EXISTS (
            SELECT 1 FROM json_each(@identities) j
            WHERE json_extract(j.value, '$[0]') = s.tool AND json_extract(j.value, '$[1]') = s.native_id))`;
        const row = this.db.prepare(`SELECT ${[...byMemory, ...bySession, identities].join(' + ')} AS remaining`).get({
            memories: plan.memoryIdsJson,
            sessions: plan.sessionIdsJson,
            identities: plan.identitiesJson,
        }) as { remaining: number };
        return Number(row.remaining);
    }

    private confirm(plan: RetentionPlan, backupPath: string): void {
        let failure: string | undefined;
        try {
            const remaining = this.remainingRows(plan);
            const measured = measureLiveMemoryBytes(this.db);
            const ledger = readLiveMemoryUsage(this.db);
            if (remaining > 0) {
                failure = `${remaining} removed row(s) are still present`;
            } else if (measured !== ledger) {
                failure = `the ledger holds ${ledger} bytes, stored rows ${measured} bytes`;
            }
        } catch (error) {
            failure = errorMessage(error);
        }
        if (failure !== undefined) {
            this.recordState('unconfirmed', failure, new Date(this.policy.now()).toISOString(), 0, backupPath);
            throw new LiveMemoryRetentionVerificationError(backupPath, failure);
        }
    }

    private deferral(
        identity: LiveMemoryCaptureIdentity,
        reason: LiveMemoryDeferralReason,
        detail: string | undefined,
        attempted: boolean,
    ): LiveMemoryCaptureDeferredError {
        const nowMs = this.policy.now();
        const now = new Date(nowMs).toISOString();
        this.db.transaction(() => {
            this.db
                .prepare(
                    `INSERT INTO ${LIVE_MEMORY_CAPTURE_DEFERRALS_TABLE} (tool, native_id, reason, first_deferred_at, last_deferred_at, attempts)
                     VALUES (?, ?, ?, ?, ?, 1)
                     ON CONFLICT (tool, native_id) DO UPDATE SET
                       reason = excluded.reason,
                       last_deferred_at = excluded.last_deferred_at,
                       attempts = attempts + 1`,
                )
                .run(identity.tool, identity.nativeId, reason, now, now);
            if (attempted) {
                this.recordState('failed', reason, now, nowMs + this.policy.retryMs, null);
            }
        })();
        return new LiveMemoryCaptureDeferredError(identity, reason, detail);
    }

    private recordState(
        outcome: 'removed' | 'failed' | 'unconfirmed',
        reason: string | null,
        attemptedAt: string,
        retryAfterMs: number,
        backupPath: string | null,
    ): void {
        this.db
            .prepare(
                `INSERT INTO ${LIVE_MEMORY_RETENTION_STATE_TABLE} (id, outcome, reason, attempted_at, retry_after_ms, backup_path)
                 VALUES (1, ?, ?, ?, ?, ?)
                 ON CONFLICT (id) DO UPDATE SET
                   outcome = excluded.outcome,
                   reason = excluded.reason,
                   attempted_at = excluded.attempted_at,
                   retry_after_ms = excluded.retry_after_ms,
                   backup_path = excluded.backup_path`,
            )
            .run(outcome, reason, attemptedAt, retryAfterMs, backupPath);
    }

    private memoryIds(identitiesJson: string): Map<string, number[]> {
        const rows = this.db
            .prepare(
                `SELECT s.tool, s.native_id, m.id
                 FROM memories m JOIN sessions s ON s.id = m.session_id
                 ${scopeClause(identitiesJson, 's.tool', 's.native_id', 'WHERE')}
                 ORDER BY m.id`,
            )
            .all(identitiesJson) as Array<{ tool: string; native_id: string; id: number }>;
        const result = new Map<string, number[]>();
        for (const row of rows) {
            const key = nativeSessionKey(row.tool, row.native_id);
            result.set(key, [...(result.get(key) ?? []), row.id]);
        }
        return result;
    }

    // Describes every native session (or only the listed ones) with the facts
    // that decide its order, size and eligibility. The same description is
    // frozen at planning and compared again inside the decisive transaction.
    private describe(trigger: LiveMemoryCaptureIdentity, identitiesJson?: string): Map<string, RetentionUnit> {
        const units = new Map<string, RetentionUnit>();
        const sessions = scopedAll(
            this.db,
            `SELECT s.id, s.tool, s.native_id, s.segment_index, s.project_id, p.path AS project_path, s.last_ingested_at,
                    s.started_at, d.state AS capture_state
             FROM sessions s
             LEFT JOIN projects p ON p.id = s.project_id
             LEFT JOIN durable_capture_status d ON d.session_id = s.id
             ${scopeClause(identitiesJson, 's.tool', 's.native_id', 'WHERE')}
             ORDER BY s.tool, s.native_id, s.segment_index, s.id`,
            identitiesJson,
        ) as Array<{
            id: number;
            tool: string;
            native_id: string;
            segment_index: number;
            project_id: number;
            project_path: string | null;
            last_ingested_at: string;
            started_at: string;
            capture_state: string | null;
        }>;
        for (const row of sessions) {
            const key = nativeSessionKey(row.tool, row.native_id);
            const unit = units.get(key) ?? {
                tool: row.tool,
                nativeId: row.native_id,
                sessions: [],
                startMs: null,
                startedAt: null,
                generation: null,
                consent: [],
                tables: {},
                bytes: 0,
            };
            unit.sessions.push({
                id: row.id,
                segment: row.segment_index,
                projectId: row.project_id,
                projectPath: row.project_path,
                lastIngestedAt: row.last_ingested_at,
                startedAt: row.started_at,
                captureState: row.capture_state,
            });
            units.set(key, unit);
        }
        const keyed = <T extends object = object>(rows: unknown[]) =>
            new Map(
                (rows as Array<T & { tool: string; native_id: string }>).map((row) => [nativeSessionKey(row.tool, row.native_id), row]),
            );

        const starts = keyed<{ start_ms: number; started_at: string }>(
            scopedAll(
                this.db,
                `SELECT s.tool, s.native_id, MIN(${START_MS}) AS start_ms, s.started_at
                 FROM sessions s
                 WHERE ${VALID_START} ${scopeClause(identitiesJson, 's.tool', 's.native_id', 'AND')}
                 GROUP BY s.tool, s.native_id`,
                identitiesJson,
            ),
        );
        const generations = keyed<{ generation: number }>(
            scopedAll(
                this.db,
                `SELECT tool, native_id, generation FROM source_generations ${scopeClause(identitiesJson, 'tool', 'native_id', 'WHERE')}`,
                identitiesJson,
            ),
        );
        const openTurns = keyed(
            scopedAll(
                this.db,
                `SELECT DISTINCT tool, native_session_id AS native_id FROM open_turns
                 ${scopeClause(identitiesJson, 'tool', 'native_session_id', 'WHERE')}`,
                identitiesJson,
            ),
        );
        // A retained rollup of another native session naming one of this
        // unit's segments as its parent would dangle once the unit is gone.
        const referencedParents = keyed(
            scopedAll(
                this.db,
                `SELECT DISTINCT ps.tool, ps.native_id
                 FROM session_rollups r
                 JOIN sessions ps ON ps.id = r.parent_session_id
                 JOIN sessions cs ON cs.id = r.session_id
                 WHERE (cs.tool <> ps.tool OR cs.native_id <> ps.native_id)
                 ${scopeClause(identitiesJson, 'ps.tool', 'ps.native_id', 'AND')}`,
                identitiesJson,
            ),
        );

        const measured = measureLiveMemoryByNativeSession(this.db, identitiesJson);
        const consentByPath = new Map<string, ConsentState>();
        const nowMs = this.policy.now();

        for (const [key, unit] of units) {
            const start = starts.get(key);
            unit.startMs = start === undefined ? null : Number(start.start_ms);
            unit.startedAt = start?.started_at ?? null;
            const generation = generations.get(key)?.generation;
            unit.generation = generation === undefined || generation === null ? null : Number(generation);
            unit.tables = measured.get(key)?.tables ?? {};
            unit.bytes = measured.get(key)?.bytes ?? 0;
            const paths = [
                ...new Set(unit.sessions.flatMap((session) => (session.projectPath === null ? [] : [session.projectPath]))),
            ].sort(compareText);
            unit.consent = paths.map((projectPath) => {
                const state = consentByPath.get(projectPath) ?? this.consent.consentState(projectPath);
                consentByPath.set(projectPath, state);
                return [projectPath, state];
            });
            const lastIngestedMs = Math.max(...unit.sessions.map((session) => Date.parse(session.lastIngestedAt)));
            if (unit.tool === trigger.tool && unit.nativeId === trigger.nativeId) {
                unit.ineligible = 'active_writer';
            } else if (openTurns.has(key)) {
                unit.ineligible = 'open_turn';
            } else if (unit.sessions.some((session) => !COMPLETE_CAPTURE_STATES.has(session.captureState as DurableCaptureState))) {
                unit.ineligible = 'capture_incomplete';
            } else if (
                unit.generation === null ||
                !Number.isFinite(lastIngestedMs) ||
                unit.sessions.some((session) => session.projectPath === null) ||
                referencedParents.has(key)
            ) {
                unit.ineligible = 'identity_uncertain';
            } else if (nowMs - lastIngestedMs < this.policy.activeWindowMs) {
                unit.ineligible = 'active_writer';
            } else if (unit.consent.some(([, state]) => state === 'pending')) {
                unit.ineligible = 'consent_unsettled';
            }
        }
        return units;
    }
}

export interface LiveMemoryRetentionReport {
    removedSessions: number;
    removedBytes: number;
    recentRemovals: Array<{ tool: string; native_id: string; source_started_at: string | null; removed_at: string; removed_bytes: number }>;
    deferrals: Array<{ tool: string; native_id: string; reason: string; last_deferred_at: string; attempts: number }>;
    state?: { outcome: string; reason: string | null; attempted_at: string; backup_path: string | null };
}

export function readLiveMemoryRetentionReport(db: Database, recentLimit: number): LiveMemoryRetentionReport {
    const totals = db
        .prepare(`SELECT COUNT(*) AS sessions, COALESCE(SUM(removed_bytes), 0) AS bytes FROM ${LIVE_MEMORY_RETENTION_REMOVALS_TABLE}`)
        .get() as { sessions: number; bytes: number };
    const recentRemovals = db
        .prepare(
            `SELECT tool, native_id, source_started_at, removed_at, removed_bytes
             FROM ${LIVE_MEMORY_RETENTION_REMOVALS_TABLE}
             ORDER BY removed_at DESC, tool, native_id LIMIT ?`,
        )
        .all(recentLimit) as LiveMemoryRetentionReport['recentRemovals'];
    const deferrals = db
        .prepare(
            `SELECT tool, native_id, reason, last_deferred_at, attempts
             FROM ${LIVE_MEMORY_CAPTURE_DEFERRALS_TABLE}
             ORDER BY last_deferred_at DESC, tool, native_id`,
        )
        .all() as LiveMemoryRetentionReport['deferrals'];
    const state = db
        .prepare(`SELECT outcome, reason, attempted_at, backup_path FROM ${LIVE_MEMORY_RETENTION_STATE_TABLE} WHERE id = 1`)
        .get() as LiveMemoryRetentionReport['state'];
    return {
        removedSessions: Number(totals.sessions),
        removedBytes: Number(totals.bytes),
        recentRemovals,
        deferrals,
        ...(state === undefined ? {} : { state }),
    };
}
