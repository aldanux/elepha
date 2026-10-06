// Database-level backstop for the fixed live-memory capacity.
//
// Ordinary capture and per-session writes run through the retention policy,
// which can clean up at capacity. Every other write (bulk imports, repairs,
// backfills, and anything added later) must still never commit a live-memory
// total at or above capacity. A canonical trigger on the ledger row enforces
// that for every connection, including ones that never ran elepha's schema
// initialization: when a write would raise the total to capacity or beyond,
// the statement aborts and its transaction rolls back. Writes that shrink or
// keep the total are never blocked, so purge, repair and cleanup always work
// even above capacity.
//
// The retention policy measures and admits its own writes, so it raises a
// bypass counter for the duration of one transaction. The counter is raised
// and restored inside that same transaction, so no other connection can ever
// observe it, and a rollback discards it with everything else.

import type { Database } from 'better-sqlite3-multiple-ciphers';
import { LIVE_MEMORY_CAPACITY_BYTES } from '../config/live-memory-retention.js';

// The abort message is the contract callers and tests recognize.
export const LIVE_MEMORY_CAPACITY_GUARD_MESSAGE = 'elepha live-memory capacity reached; write refused';

export const LIVE_MEMORY_CAPACITY_TABLE = 'live_memory_capacity';
export const LIVE_MEMORY_CAPACITY_GUARD_TRIGGER = 'live_memory_capacity_guard';

export const LIVE_MEMORY_CAPACITY_SCHEMA = `CREATE TABLE IF NOT EXISTS ${LIVE_MEMORY_CAPACITY_TABLE} (
  id             INTEGER PRIMARY KEY CHECK (id = 1),
  capacity_bytes INTEGER NOT NULL CHECK (capacity_bytes > 0),
  bypass_depth   INTEGER NOT NULL DEFAULT 0 CHECK (bypass_depth >= 0)
)`;

// The definition exactly as SQLite stores it; the ledger module installs and
// verifies it together with the ledger's own triggers.
export function liveMemoryCapacityGuardSql(ledgerTable: string): string {
    return `CREATE TRIGGER ${LIVE_MEMORY_CAPACITY_GUARD_TRIGGER} BEFORE UPDATE OF total_bytes ON ${ledgerTable}
WHEN NEW.total_bytes > OLD.total_bytes
 AND NEW.total_bytes >= (SELECT capacity_bytes FROM ${LIVE_MEMORY_CAPACITY_TABLE} WHERE id = 1)
 AND (SELECT bypass_depth FROM ${LIVE_MEMORY_CAPACITY_TABLE} WHERE id = 1) = 0
BEGIN
  SELECT RAISE(ABORT, '${LIVE_MEMORY_CAPACITY_GUARD_MESSAGE}');
END`;
}

// Sets the enforced capacity on every open, so a value carried in from another
// database or left by a test never outlives the process that set it.
export function configureLiveMemoryCapacity(db: Database, capacityBytes: number = LIVE_MEMORY_CAPACITY_BYTES): void {
    db.exec(LIVE_MEMORY_CAPACITY_SCHEMA);
    db.prepare(
        `INSERT INTO ${LIVE_MEMORY_CAPACITY_TABLE} (id, capacity_bytes, bypass_depth) VALUES (1, ?, 0)
         ON CONFLICT (id) DO UPDATE SET capacity_bytes = excluded.capacity_bytes, bypass_depth = 0`,
    ).run(capacityBytes);
}

// Creates the capacity row without changing an existing value.
export function ensureLiveMemoryCapacity(db: Database): void {
    db.exec(LIVE_MEMORY_CAPACITY_SCHEMA);
    db.prepare(`INSERT OR IGNORE INTO ${LIVE_MEMORY_CAPACITY_TABLE} (id, capacity_bytes, bypass_depth) VALUES (1, ?, 0)`).run(
        LIVE_MEMORY_CAPACITY_BYTES,
    );
}

// Test seam: isolated tests lower the enforced capacity together with the
// retention policy's instead of allocating gigabytes.
export function setLiveMemoryCapacityGuard(db: Database, capacityBytes: number): void {
    configureLiveMemoryCapacity(db, capacityBytes);
}

// Runs a write the retention policy measures and admits itself, inside one
// transaction (a savepoint when the caller already holds one).
export function withLiveMemoryCapacityGuardBypassed<T>(db: Database, action: () => T): T {
    return db.transaction(() => {
        const adjust = db.prepare(`UPDATE ${LIVE_MEMORY_CAPACITY_TABLE} SET bypass_depth = bypass_depth + ? WHERE id = 1`);
        adjust.run(1);
        try {
            return action();
        } finally {
            adjust.run(-1);
        }
    })();
}

// A bulk operation that cannot run automatic cleanup refuses to commit a
// result at or above capacity.
export class LiveMemoryCapacityError extends Error {
    constructor(
        readonly totalBytes: number,
        readonly capacityBytes: number,
    ) {
        super(`${LIVE_MEMORY_CAPACITY_GUARD_MESSAGE}: the result would hold ${totalBytes} of ${capacityBytes} bytes; nothing was changed`);
        this.name = 'LiveMemoryCapacityError';
    }
}

export function isLiveMemoryCapacityGuardError(error: unknown): boolean {
    return error instanceof Error && error.message.includes(LIVE_MEMORY_CAPACITY_GUARD_MESSAGE);
}
