// Persistence for session-level rollups.
//
// The hard problem here is idempotency. `memories` is protected by
// UNIQUE(session_id, turn_index): re-processing a turn is a no-op. A rollup is
// a MUTABLE AGGREGATE with no such guard - applying the same new turns twice
// would double-count decisions, resurrect resolved pending_items, and inflate
// turn_count. And re-processing is not hypothetical: "closed" is a heuristic
// (file idle), and Codex Desktop reopens sessions days later and appends to the
// original rollout, so final -> live -> final can repeat indefinitely.
//
// Two independent guards, either of which alone would be sufficient:
//
// 1. WATERMARK, enforced in SQL. rolled_up_through_turn_index advances in the
//    SAME transaction that writes the content it accounts for, and the write
//    is conditional on the watermark still being where the caller read it
//    (`WHERE rolled_up_through_turn_index = :expected`). A duplicate or
//    concurrent apply finds the watermark moved and writes nothing. A crash
//    between the LLM call and the commit costs one wasted call and changes
//    nothing on disk.
// 2. SET SEMANTICS in the merge itself. decisions dedupe by `what`,
//    pending_items and files_touched by value. Applying the same merge twice
//    yields the same arrays.

import type { Database, Statement } from 'better-sqlite3';
import { dedupePaths } from '../config/paths.js';
import { escapeShellSyntax, stripShellSyntax } from '../security/sanitize.js';

// Every rollup from the old schema is stale, for three independent reasons
// that all landed together so the corpus is rebuilt once rather than three
// times:
//
// - the prompt builder end-truncated its input, so on large sessions the
//   newest turns never reached the model (measured: 83% of all lost decisions);
// - decisions now carry `turnIndex`/`at` provenance, assigned in code;
// - `why` is now captured at the turn, where the transcript is still in the
//   prompt, instead of being inferred afterwards from the decision text.
//
// `elepha rollup --rebuild` is what actually reaches them: the default sweep
// skips `final` rollups.
export const ROLLUP_VERSION = 2;

export type RollupState = 'live' | 'final';

export interface RollupDecision {
    what: string;
    why: string;
    // Turn this decision came from. Optional because rows written before
    // provenance existed have none, and because the model cannot be trusted to
    // supply it - it is assigned deterministically in code and only
    // accepted from the model when it names a turn that was actually in the
    // batch.
    turnIndex?: number;
    // Timestamp of that turn, denormalized so ordering needs no join.
    at?: string;
}

// Newest-first by provenance. Decisions with no `turnIndex` (pre-provenance
// rows) sort oldest, which is both true and the safe direction: they are never
// preferred over a decision we can actually place in time.
export function sortDecisionsByTurn(decisions: RollupDecision[]): RollupDecision[] {
    return [...decisions].sort((a, b) => (b.turnIndex ?? -1) - (a.turnIndex ?? -1));
}

// The newest K decisions, in turn order. This is the selection the brief and
// the carried-rollup budget both need, and it lives HERE, in code, rather than
// in a prompt instruction - the merge model demonstrably drops new decisions
// when asked politely not to, and a selection rule that the model can violate
// is not a selection rule.
export function newestDecisions(decisions: RollupDecision[], k: number): RollupDecision[] {
    return sortDecisionsByTurn(decisions)
        .slice(0, k)
        .sort((a, b) => (a.turnIndex ?? -1) - (b.turnIndex ?? -1));
}

export interface SessionRollupRow {
    session_id: number;
    project_id: number;
    tool: string;
    title: string;
    summary: string;
    decisions: RollupDecision[];
    pending_items: string[];
    files_touched: string[];
    turn_count: number;
    started_at: string;
    ended_at: string;
    kind: string;
    parent_session_id: number | null;
    summarizer_status: string;
    rollup_state: RollupState;
    rolled_up_through_turn_index: number;
    computed_at: string;
    rollup_version: number;
}

export interface RollupWrite {
    sessionId: number;
    projectId: number;
    tool: string;
    title: string;
    summary: string;
    decisions: RollupDecision[];
    pendingItems: string[];
    filesTouched: string[];
    turnCount: number;
    startedAt: string;
    endedAt: string;
    kind: string;
    parentSessionId: number | null;
    summarizerStatus: string;
    state: RollupState;
    throughTurnIndex: number;
    // Overrides the stamped `rollup_version`. Omit for the normal case
    // (current version). A rebuild-in-progress passes the OLD version for
    // every batch except its last, so the row stays a rebuild candidate
    // (`rollup_version <> current`) until the rebuild actually finishes.
    rollupVersion?: number;
}

type RawRollupRow = Omit<SessionRollupRow, 'decisions' | 'pending_items' | 'files_touched'> & {
    decisions: string;
    pending_items: string;
    files_touched: string;
};

function hydrate(row: RawRollupRow | undefined): SessionRollupRow | undefined {
    if (!row) {
        return undefined;
    }
    return {
        ...row,
        decisions: JSON.parse(row.decisions),
        pending_items: JSON.parse(row.pending_items),
        files_touched: JSON.parse(row.files_touched),
    };
}

// Merges two rollup halves with set semantics, so applying the same merge twice is a no-op.
export function mergeRollupContent(
    previous: { decisions: RollupDecision[]; pendingItems: string[]; filesTouched: string[] },
    incoming: { decisions: RollupDecision[]; pendingItems: string[]; filesTouched: string[] },
): { decisions: RollupDecision[]; pendingItems: string[]; filesTouched: string[] } {
    const byWhat = new Map<string, RollupDecision>();
    for (const d of [...previous.decisions, ...incoming.decisions]) {
        // Sanitize-normalized key. `previous` was read back from the store and
        // is therefore already escaped (Rule 3 runs in write() below), while
        // `incoming` is raw summarizer output. Keying on the raw text would
        // make the same decision hash two different ways across the sanitize
        // boundary and defeat the dedupe that makes this merge idempotent.
        const key = escapeShellSyntax(d.what).trim().toLowerCase();
        const seen = byWhat.get(key);
        if (!seen) {
            byWhat.set(key, d);
            continue;
        }
        // Same decision seen twice: keep the EARLIEST turn_index, because the
        // first occurrence is when the choice was actually made - a later
        // restatement is the model repeating itself, not a new decision. But
        // prefer any provenance over none, so a pre-provenance row does not
        // block a placed one.
        if (seen.turnIndex === undefined && d.turnIndex !== undefined) {
            byWhat.set(key, { ...seen, turnIndex: d.turnIndex, at: d.at });
        } else if (seen.turnIndex !== undefined && d.turnIndex !== undefined && d.turnIndex < seen.turnIndex) {
            byWhat.set(key, { ...seen, turnIndex: d.turnIndex, at: d.at });
        }
    }
    // pending_items come from the merge model, which is told to drop resolved
    // ones - so incoming REPLACES rather than unions, otherwise a resolved item
    // could never leave the list.
    const pendingItems = [...new Set(incoming.pendingItems.map((p) => p.trim()).filter(Boolean))];
    return {
        // Stored in turn order, oldest first, so array position carries meaning
        // and "the newest K" is a slice rather than a search.
        decisions: [...byWhat.values()].sort((a, b) => (a.turnIndex ?? -1) - (b.turnIndex ?? -1)),
        pendingItems,
        filesTouched: dedupePaths([...previous.filesTouched, ...incoming.filesTouched]),
    };
}

export class RollupStore {
    private readonly db: Database;
    private readonly stmts: {
        get: Statement;
        insert: Statement;
        updateIfWatermark: Statement;
        markLive: Statement;
        listByProject: Statement;
    };

    constructor(db: Database) {
        this.db = db;
        this.stmts = {
            get: db.prepare('SELECT * FROM session_rollups WHERE session_id = ?'),
            // Upsert, not a plain insert: this path serves both the first
            // rollup and a rollup_version rebuild, where a row already exists
            // and must be replaced wholesale rather than merged onto.
            insert: db.prepare(
                `INSERT INTO session_rollups
           (session_id, project_id, tool, title, summary, decisions, pending_items, files_touched,
            turn_count, started_at, ended_at, kind, parent_session_id, summarizer_status,
            rollup_state, rolled_up_through_turn_index, computed_at, rollup_version)
         VALUES (@session_id, @project_id, @tool, @title, @summary, @decisions, @pending_items, @files_touched,
            @turn_count, @started_at, @ended_at, @kind, @parent_session_id, @summarizer_status,
            @rollup_state, @through, @now, @version)
         ON CONFLICT (session_id) DO UPDATE SET
           title = excluded.title, summary = excluded.summary, decisions = excluded.decisions,
           pending_items = excluded.pending_items, files_touched = excluded.files_touched,
           turn_count = excluded.turn_count, started_at = excluded.started_at, ended_at = excluded.ended_at,
           kind = excluded.kind, parent_session_id = excluded.parent_session_id,
           summarizer_status = excluded.summarizer_status,
           rollup_state = excluded.rollup_state,
           rolled_up_through_turn_index = excluded.rolled_up_through_turn_index,
           computed_at = excluded.computed_at, rollup_version = excluded.rollup_version`,
            ),
            // Conditional on the watermark the caller observed: a second apply
            // of the same turns finds it already advanced and changes nothing.
            updateIfWatermark: db.prepare(
                `UPDATE session_rollups SET
           title = @title, summary = @summary, decisions = @decisions,
           pending_items = @pending_items, files_touched = @files_touched,
           turn_count = @turn_count, ended_at = @ended_at,
           summarizer_status = @summarizer_status,
           rollup_state = @rollup_state, rolled_up_through_turn_index = @through,
           computed_at = @now, rollup_version = @version
         WHERE session_id = @session_id AND rolled_up_through_turn_index = @expected`,
            ),
            markLive: db.prepare(`UPDATE session_rollups SET rollup_state = 'live' WHERE session_id = ? AND rollup_state = 'final'`),
            listByProject: db.prepare('SELECT * FROM session_rollups WHERE project_id = ? ORDER BY ended_at DESC'),
        };
    }

    get(sessionId: number): SessionRollupRow | undefined {
        return hydrate(this.stmts.get.get(sessionId) as RawRollupRow | undefined);
    }

    // Writes a rollup. `expectedThroughTurnIndex` is the watermark the caller
    // read before computing; the update only lands if it hasn't moved since.
    // Returns false when the write was rejected as already-applied - that is a
    // normal outcome, not an error.
    write(w: RollupWrite, expectedThroughTurnIndex: number | undefined): boolean {
        // Security Rule 3 CHOKE POINT, not caller discipline: a caller can
        // forget, a store cannot. Display strings are stripped (the
        // metacharacter carries nothing there); decisions are escaped, because
        // a decision may legitimately need to name the syntax it ruled out.
        const params = {
            session_id: w.sessionId,
            project_id: w.projectId,
            tool: w.tool,
            title: stripShellSyntax(w.title),
            summary: stripShellSyntax(w.summary),
            decisions: JSON.stringify(
                w.decisions.map((d) => ({
                    what: escapeShellSyntax(d.what),
                    why: escapeShellSyntax(d.why),
                    ...(d.turnIndex !== undefined ? { turnIndex: d.turnIndex } : {}),
                    ...(d.at !== undefined ? { at: d.at } : {}),
                })),
            ),
            pending_items: JSON.stringify(w.pendingItems.map(stripShellSyntax)),
            files_touched: JSON.stringify(dedupePaths(w.filesTouched)),
            turn_count: w.turnCount,
            started_at: w.startedAt,
            ended_at: w.endedAt,
            kind: w.kind,
            parent_session_id: w.parentSessionId,
            summarizer_status: w.summarizerStatus,
            rollup_state: w.state,
            through: w.throughTurnIndex,
            now: new Date().toISOString(),
            version: w.rollupVersion ?? ROLLUP_VERSION,
        };

        const run = this.db.transaction(() => {
            if (expectedThroughTurnIndex === undefined) {
                this.stmts.insert.run(params);
                return true;
            }
            return this.stmts.updateIfWatermark.run({ ...params, expected: expectedThroughTurnIndex }).changes > 0;
        });
        return run();
    }

    // Reopened session: a final rollup returns to live so the next close recomputes it incrementally.
    markLive(sessionId: number): void {
        this.stmts.markLive.run(sessionId);
    }

    listByProject(projectId: number): SessionRollupRow[] {
        return (this.stmts.listByProject.all(projectId) as RawRollupRow[]).map((r) => hydrate(r) as SessionRollupRow);
    }

    // The listing view: top-level sessions with their sub-agent work attached,
    // rather than sub-agents competing for space as peers. Sub-agents are 36% of
    // Claude Code sessions locally (16 of 44) at a median of one turn each, so
    // listing them flat buries the real sessions.
    //
    // Nothing is deleted from storage, and every child stays reachable through
    // its parent. The served read model computes substance, so this
    // legacy rollup listing no longer reads the inert stored column.
    listSessions(projectId: number, options: { includeAll?: boolean } = {}): SessionListEntry[] {
        const all = this.listByProject(projectId);
        const childrenByParent = new Map<number, SessionRollupRow[]>();
        for (const r of all) {
            if (r.parent_session_id == null) {
                continue;
            }
            const bucket = childrenByParent.get(r.parent_session_id);
            if (bucket) {
                bucket.push(r);
            } else {
                childrenByParent.set(r.parent_session_id, [r]);
            }
        }

        const entries: SessionListEntry[] = [];
        for (const rollup of all) {
            const isChild = rollup.parent_session_id != null;
            // A child whose parent is present in this project is surfaced under
            // the parent. An orphaned child (parent never ingested, or in
            // another project) is still listed on its own - hiding it would
            // lose it entirely.
            const parentPresent = isChild && all.some((r) => r.session_id === rollup.parent_session_id);
            if (parentPresent && !options.includeAll) {
                continue;
            }

            entries.push({ rollup, children: childrenByParent.get(rollup.session_id) ?? [] });
        }
        return entries;
    }
}

export interface SessionListEntry {
    rollup: SessionRollupRow;
    // Sub-agent rollups belonging to this session. Empty for a session with no sub-agents.
    children: SessionRollupRow[];
}
