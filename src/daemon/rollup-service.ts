// Decides WHEN a session rolls up, and drives the incremental merge.
//
// Close detection is a heuristic and is treated as one everywhere: a session
// whose transcript file has been idle for IDLE_CLOSE_MS is rolled up and marked
// 'final', but "final" only means "quiet for a while". Codex Desktop reopens
// sessions days later and appends to the original rollout file, so a final
// rollup can be woken back to 'live' any number of times. RollupStore's
// watermark prevents reprocessing the same turns from double-counting.

import { IDLE_CLOSE_MS } from '../config/constants.js';
import { dedupePaths } from '../config/paths.js';
import type { MemoryRow, MemoryStore, SessionRow } from '../storage/memory-store.js';
import { mergeRollupContent, ROLLUP_VERSION, type RollupDecision, type RollupStore } from '../storage/rollup-store.js';
import { chunkTurns, type RollupTurnInput } from '../summarizer/rollup-prompt.js';
import { attributeDecisions, type RollupProvider } from '../summarizer/rollup-provider.js';
import type { SessionKind } from '../types/index.js';

// Result of one `rollupSession` call. `wrote` is true if any batch landed;
// `complete` is true only if every fresh batch was processed without an
// abort (a failed summarization or a concurrent writer moving the
// watermark). A caller that only checks `wrote` (as the old boolean return
// did) can't tell a full rebuild from a partial one that got interrupted
// three batches in - that's the CLI's "Rolled up 10 session(s)" false
// success line, fixed at the source.
export interface RollupOutcome {
    wrote: boolean;
    complete: boolean;
}

// True if the session's stored watermark still matches what this batch's
// write is about to be conditioned on. `expected: undefined` (the
// unconditional first batch of a from-scratch rebuild) always matches -
// there's nothing to verify against yet. Checked immediately before every
// batch's model call, not just at write time: it can't close the race
// entirely (a concurrent writer can still land mid-API-call, which only the
// write's own conditional UPDATE catches), but it does turn a same-tick
// collision into a free skip instead of a paid-for one.
export function watermarkStillMatches(rollups: RollupStore, sessionId: number, expected: number | undefined): boolean {
    if (expected === undefined) {
        return true;
    }
    return rollups.get(sessionId)?.rolled_up_through_turn_index === expected;
}

// How long a transcript file must be idle before its session is considered closed.
function toRollupInput(rows: MemoryRow[]): RollupTurnInput[] {
    return rows.map((r) => ({
        turnIndex: r.turn_index,
        startedAt: r.turn_started_at,
        // Rationale captured at the turn, where the transcript was still in
        // the prompt, is passed through verbatim. A null `why` is rendered as
        // nothing rather than as an empty "because" - the rollup model must be
        // able to see that no reason was recorded, so it does not fill one in.
        decisions: r.decisions.map((d) => (d.why ? `${d.what} (because ${d.why})` : d.what)),
        pendingItems: r.pending_items,
        filesTouched: r.files_touched,
    }));
}

export interface RollupServiceOptions {
    store: MemoryStore;
    rollups: RollupStore;
    provider: RollupProvider;
    idleCloseMs?: number;
    log?: (msg: string) => void;
    logError?: (msg: string) => void;
}

export class RollupService {
    private readonly store: MemoryStore;
    private readonly rollups: RollupStore;
    private readonly provider: RollupProvider;
    private readonly idleCloseMs: number;
    private readonly log: (msg: string) => void;
    private readonly logError: (msg: string) => void;

    constructor(options: RollupServiceOptions) {
        this.store = options.store;
        this.rollups = options.rollups;
        this.provider = options.provider;
        this.idleCloseMs = options.idleCloseMs ?? IDLE_CLOSE_MS;
        this.log = options.log ?? (() => {});
        this.logError = options.logError ?? this.log;
    }

    // A new turn landed: any 'final' rollup for this session is stale and must return to 'live'.
    noteActivity(sessionDbId: number): void {
        this.rollups.markLive(sessionDbId);
    }

    // Rolls up one session, incrementally when a rollup already exists.
    //
    // `complete: false` covers everything that isn't "every fresh batch
    // landed" - no turns past the watermark, a failed summarization, or
    // another writer moving the watermark underneath a multi-batch rebuild.
    async rollupSession(
        session: SessionRow,
        kind: SessionKind,
        parentSessionId: number | null,
        state: 'live' | 'final',
    ): Promise<RollupOutcome> {
        const all = this.store.listMemoriesForSession(session.id);
        if (all.length === 0) {
            return { wrote: false, complete: true };
        }

        const stored = this.rollups.get(session.id);
        // A rollup written by an older prompt/schema is rebuilt from scratch
        // rather than merged onto - merging new turns into stale-format content
        // would preserve the very thing the version bump exists to replace.
        const stale = stored !== undefined && stored.rollup_version !== ROLLUP_VERSION;
        if (stale) {
            this.log(`[elepha] rollup for session ${session.id} is v${stored.rollup_version} (current v${ROLLUP_VERSION}); rebuilding`);
        }
        const existing = stale ? undefined : stored;

        const watermark = existing?.rolled_up_through_turn_index;
        const fresh = watermark === undefined ? all : all.filter((t) => t.turn_index > watermark);
        if (fresh.length === 0) {
            // Nothing new; only the state may need to change.
            if (existing && existing.rollup_state !== state) {
                this.rollups.write(this.toWrite(session, all, existing, kind, parentSessionId, state), watermark);
            }
            return { wrote: false, complete: true };
        }

        // CHUNKED, not truncated. The prompt builder used to cut the rendered
        // turns at 12,000/8,000 chars FROM THE END, so on a large session the
        // newest turns never reached the model - the mechanical half of the
        // merge-loss bug. Turns are now split into ordered batches that each
        // fit the budget, and every batch is sent.
        const batches = chunkTurns(toRollupInput(fresh));
        const rowsByTurnIndex = new Map(fresh.map((t) => [t.turn_index, t]));

        // Per-BATCH watermark, not per-session. Each write is conditional on
        // the watermark the previous batch left, so a failure part-way through
        // a 20-batch session keeps the batches that did land instead of
        // discarding the whole session's work, and the next pass resumes from
        // there.
        let carry:
            | { title: string; summary: string; decisions: RollupDecision[]; pendingItems: string[]; filesTouched: string[] }
            | undefined = existing
            ? {
                  title: existing.title,
                  summary: existing.summary,
                  decisions: existing.decisions,
                  pendingItems: existing.pending_items,
                  filesTouched: existing.files_touched,
              }
            : undefined;
        let expected = watermark;
        let wroteAny = false;

        for (const [index, batch] of batches.entries()) {
            if (batch.omitted > 0) {
                // A single turn too large for one batch is the one irreducible
                // ceiling. It binds from the oldest end and it is never silent.
                this.log(
                    `[elepha] session ${session.id} batch ${index + 1}/${batches.length}: ${batch.omitted} oldest item(s) omitted from an oversized turn`,
                );
            }

            // Re-check immediately before spending on the model call, not just
            // at write time. Doesn't close the race (a concurrent writer can
            // still land during the awaited call below, which only the
            // write's own conditional UPDATE catches) but it does mean a
            // collision that already happened before this batch started costs
            // nothing instead of one wasted API call.
            if (!watermarkStillMatches(this.rollups, session.id, expected)) {
                this.log(
                    `[elepha] rollup for session ${session.id} aborted before batch ${index + 1}/${batches.length}: watermark moved (a concurrent writer got there first) - no API call made`,
                );
                return { wrote: wroteAny, complete: false };
            }

            const result = carry
                ? await this.provider.merge(
                      { title: carry.title, summary: carry.summary, decisions: carry.decisions, pendingItems: carry.pendingItems },
                      batch.turns,
                  )
                : await this.provider.rollup(batch.turns);

            if (result.status !== 'ok') {
                // Never advance the watermark on a failed summarization - the
                // turns stay unaccounted for and a later pass retries them.
                // Storing an empty rollup and marking it done is exactly the
                // silent degradation this codebase has already paid for once.
                this.logError(
                    `[elepha] rollup for session ${session.id} failed at batch ${index + 1}/${batches.length} (${result.status}); watermark left at ${expected ?? 'none'}`,
                );
                return { wrote: wroteAny, complete: false };
            }

            if (result.output.droppedDecisions > 0) {
                // Never silent: a rollup quietly losing decisions to a prompt
                // regression must be distinguishable from a quiet session.
                this.log(
                    `[elepha] session ${session.id} batch ${index + 1}/${batches.length}: dropped ${result.output.droppedDecisions} decision(s) with no usable what/why`,
                );
            }

            const batchHighWater = Math.max(...batch.turns.map((t) => t.turnIndex));
            const incoming = {
                // Provenance assigned HERE, in code. The prompt asks the model
                // for turn_index, but the reason this exists at all is that the
                // merge model does not reliably follow ordering instructions -
                // so its answer is a hint, checked against the batch, with a
                // deterministic fallback.
                decisions: attributeDecisions(result.output.decisions, batch.turns) as RollupDecision[],
                pendingItems: result.output.pending_items,
                // From the stored rows, not from the rendered batch: an
                // oversized turn has its file list dropped for rendering only.
                filesTouched: dedupePaths(batch.turns.flatMap((t) => rowsByTurnIndex.get(t.turnIndex)?.files_touched ?? [])),
            };
            const merged = carry
                ? mergeRollupContent(
                      { decisions: carry.decisions, pendingItems: carry.pendingItems, filesTouched: carry.filesTouched },
                      incoming,
                  )
                : incoming;

            const wrote = this.rollups.write(
                {
                    sessionId: session.id,
                    projectId: session.project_id,
                    tool: session.tool,
                    title: result.output.title,
                    summary: result.output.summary,
                    decisions: merged.decisions,
                    pendingItems: merged.pendingItems,
                    filesTouched: merged.filesTouched,
                    turnCount: all.length,
                    startedAt: all[0]?.turn_started_at,
                    endedAt: all[all.length - 1]?.turn_started_at,
                    kind,
                    parentSessionId,
                    summarizerStatus: result.status,
                    // Only the final batch may mark the rollup final; an
                    // intermediate batch leaves it live, because it is.
                    state: index === batches.length - 1 ? state : 'live',
                    throughTurnIndex: batchHighWater,
                    // A rebuild (stale) that hasn't reached its last batch yet
                    // keeps the OLD version stamped, not the current one - an
                    // interrupted rebuild must stay a rebuild candidate
                    // (rollup_version <> current), not silently look done
                    // because its first batch happened to land. Only matters
                    // while stale; a plain incremental write is always current.
                    // biome-ignore lint/style/noNonNullAssertion: stored is defined whenever stale is true, by stale's own definition
                    rollupVersion: !stale || index === batches.length - 1 ? ROLLUP_VERSION : stored!.rollup_version,
                },
                expected,
            );

            if (!wrote) {
                this.log(`[elepha] rollup for session ${session.id} skipped at batch ${index + 1}: watermark moved (already applied)`);
                return { wrote: wroteAny, complete: false };
            }

            wroteAny = true;
            expected = batchHighWater;
            carry = {
                title: result.output.title,
                summary: result.output.summary,
                // Read back what was actually stored: RollupStore.write()
                // sanitizes (Rule 3), and carrying the unsanitized in-memory
                // copy forward would make the next merge's dedupe key differ
                // from the stored one.
                decisions: this.rollups.get(session.id)?.decisions ?? merged.decisions,
                pendingItems: merged.pendingItems,
                filesTouched: merged.filesTouched,
            };
        }

        return { wrote: wroteAny, complete: true };
    }

    private toWrite(
        session: SessionRow,
        all: MemoryRow[],
        existing: NonNullable<ReturnType<RollupStore['get']>>,
        kind: SessionKind,
        parentSessionId: number | null,
        state: 'live' | 'final',
    ) {
        return {
            sessionId: session.id,
            projectId: session.project_id,
            tool: session.tool,
            title: existing.title,
            summary: existing.summary,
            decisions: existing.decisions,
            pendingItems: existing.pending_items,
            filesTouched: existing.files_touched,
            turnCount: all.length,
            startedAt: existing.started_at,
            endedAt: all[all.length - 1]?.turn_started_at,
            kind,
            parentSessionId,
            summarizerStatus: existing.summarizer_status,
            state,
            throughTurnIndex: existing.rolled_up_through_turn_index,
        };
    }

    // True when a transcript file has been quiet long enough to treat the session as closed.
    isIdle(mtimeMs: number, now = Date.now()): boolean {
        return now - mtimeMs >= this.idleCloseMs;
    }
}
