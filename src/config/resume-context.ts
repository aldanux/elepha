// Bounds of one step reconstructing the resume context for a capture cursor
// stored before resume contexts were recorded. Each step is one daemon
// work-queue job; an unfinished reconstruction continues in the next job from
// where the last one stopped, and the capture cursor does not move until it
// completes.

// Source bytes one step may read. A step reads past this only to finish the
// record it started, so a record larger than the allowance still progresses.
export const RESUME_CONTEXT_STEP_BYTES = 8 * 1024 * 1024;

// Wall-clock time one step may spend reading before it yields.
export const RESUME_CONTEXT_STEP_MS = 500;
