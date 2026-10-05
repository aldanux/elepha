// Bounds of one task-state manifest recovery pass. A pass runs as a single
// daemon work-queue job; whatever it cannot finish continues in a later job,
// so live capture and heartbeat work interleave with a long recovery.

// Unconsumed precompact requests a pass inspects before yielding.
export const TASK_STATE_MANIFEST_RECOVERY_BATCH = 16;

// Transcript bytes a pass may read across all of its requests. A reporting
// turn larger than this cannot be re-read within one pass, so its request is
// reported and left pending instead of being retried in a loop.
export const TASK_STATE_MANIFEST_RECOVERY_PASS_BYTES = 16 * 1024 * 1024;

// Wall-clock time a pass may spend reading transcripts before it yields.
export const TASK_STATE_MANIFEST_RECOVERY_PASS_MS = 500;
