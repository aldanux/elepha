// Fixed live-memory retention policy. Every value is decimal bytes of the
// logical live-memory ledger, not the size of the database file on disk.
export const LIVE_MEMORY_CAPACITY_BYTES = 5_000_000_000;

// 80% of capacity. From exactly this value a warning is due once per
// cadence interval; any lower observation rearms the schedule. A capture write
// that jumps from below this value straight to capacity never triggers
// cleanup, because no warning could have preceded it.
export const LIVE_MEMORY_WARNING_BYTES = 4_000_000_000;

// 95% of capacity. From exactly this value every new chat opening warns,
// independently of the weekly cadence.
export const LIVE_MEMORY_URGENT_WARNING_BYTES = 4_750_000_000;

// Cleanup removes the smallest oldest-first prefix of whole native sessions
// that brings the total, including the triggering write, to at most this
// value. It matches the urgent band so a cleanup lands just below it.
export const LIVE_MEMORY_CLEANUP_TARGET_BYTES = 4_750_000_000;

// Below the urgent band, at most one warning per seven days. Missed weeks do
// not queue: the next due opening warns once and restarts the interval.
export const LIVE_MEMORY_WARNING_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

// A native chat ingested within this window may still be receiving turns, so
// cleanup never selects it. A day is far shorter than the history cleanup
// reaches at capacity and far longer than any idle gap inside one sitting.
export const LIVE_MEMORY_ACTIVE_WINDOW_MS = 24 * 60 * 60 * 1000;

// After a cleanup attempt fails, captures that still need cleanup are deferred
// without another attempt for this long. Each attempt remeasures and snapshots
// a database near capacity, so retrying on every turn would stall capture.
export const LIVE_MEMORY_CLEANUP_RETRY_MS = 15 * 60 * 1000;

// Removed native sessions listed by `elepha status`, newest first.
export const LIVE_MEMORY_REMOVALS_STATUS_LIMIT = 10;
