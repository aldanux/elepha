// Schedule state for the live-memory capacity warning.
//
// One optional row holds when the next weekly warning becomes due. No row
// means armed: the next new chat opening in the warning band warns. The row
// is a cadence cursor only. It is advanced when a chat opening decides to
// warn, not when output is written, and never records that a host displayed
// the warning or that a human read it; nothing about capture or cleanup
// depends on it.

import type { Database } from 'better-sqlite3-multiple-ciphers';
import {
    LIVE_MEMORY_URGENT_WARNING_BYTES,
    LIVE_MEMORY_WARNING_BYTES,
    LIVE_MEMORY_WARNING_INTERVAL_MS,
} from '../config/live-memory-retention.js';
import { readLiveMemoryUsage } from './live-memory-usage.js';

export const LIVE_MEMORY_WARNING_SCHEDULE_TABLE = 'live_memory_warning_schedule';

// The retired single-epoch table carried claim leases and stdout-write
// receipts. Those receipts never proved a human saw anything, so none of its
// state carries over: the new schedule starts armed.
export const RETIRED_LIVE_MEMORY_WARNING_TABLE = 'live_memory_warning';

export type LiveMemoryWarningBand = 'weekly' | 'urgent';

export interface LiveMemoryWarningPolicy {
    enabled: boolean;
    // Isolated tests and host probes substitute a fixed usage instead of
    // allocating gigabytes or altering a real ledger.
    readUsage: (db: Database) => number;
}

// Active together with automatic cleanup at capacity: the warning describes
// the cleanup that the capture write path now performs.
export const LIVE_MEMORY_WARNING_POLICY: LiveMemoryWarningPolicy = {
    enabled: true,
    readUsage: readLiveMemoryUsage,
};

const SCHEMA = `CREATE TABLE IF NOT EXISTS ${LIVE_MEMORY_WARNING_SCHEDULE_TABLE} (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  next_due_ms INTEGER NOT NULL CHECK (next_due_ms >= 0)
)`;

export function migrateLiveMemoryWarning(db: Database): void {
    db.exec(`DROP TABLE IF EXISTS ${RETIRED_LIVE_MEMORY_WARNING_TABLE}`);
    db.exec(SCHEMA);
}

export function liveMemoryWarningBand(usageBytes: number): LiveMemoryWarningBand | undefined {
    if (usageBytes >= LIVE_MEMORY_URGENT_WARNING_BYTES) {
        return 'urgent';
    }
    return usageBytes >= LIVE_MEMORY_WARNING_BYTES ? 'weekly' : undefined;
}

export function liveMemoryWarningNextDue(db: Database): number | undefined {
    const row = db.prepare(`SELECT next_due_ms FROM ${LIVE_MEMORY_WARNING_SCHEDULE_TABLE} WHERE id = 1`).get() as
        | { next_due_ms: number }
        | undefined;
    return row?.next_due_ms;
}

// Decides whether one new chat opening warns, and advances the schedule when
// it does. Below the warning band the schedule rearms. In the weekly band the
// opening warns only when due. In the urgent band every opening warns; it
// also restarts the weekly interval, so falling back into the weekly band
// does not repeat a warning the user was just shown. Joins the caller's
// transaction, so concurrent openings serialize and one due slot warns once.
export function takeChatOpeningLiveMemoryWarning(db: Database, usageBytes: number, nowMs: number): LiveMemoryWarningBand | undefined {
    return db.transaction((): LiveMemoryWarningBand | undefined => {
        const band = liveMemoryWarningBand(usageBytes);
        if (band === undefined) {
            db.prepare(`DELETE FROM ${LIVE_MEMORY_WARNING_SCHEDULE_TABLE} WHERE id = 1`).run();
            return undefined;
        }
        const nextDue = liveMemoryWarningNextDue(db);
        // A due time more than one interval ahead means the clock moved
        // backwards; waiting for it could silence the warning indefinitely.
        const due = nextDue === undefined || nowMs >= nextDue || nextDue - nowMs > LIVE_MEMORY_WARNING_INTERVAL_MS;
        if (band === 'weekly' && !due) {
            return undefined;
        }
        db.prepare(
            `INSERT INTO ${LIVE_MEMORY_WARNING_SCHEDULE_TABLE} (id, next_due_ms) VALUES (1, ?)
             ON CONFLICT(id) DO UPDATE SET next_due_ms = excluded.next_due_ms`,
        ).run(nowMs + LIVE_MEMORY_WARNING_INTERVAL_MS);
        return band;
    })();
}
