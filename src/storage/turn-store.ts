import type { Database, Statement } from 'better-sqlite3-multiple-ciphers';
import { dedupePaths } from '../config/paths.js';
import { filterTurn } from '../rendering/filtered-turn.js';
import { RAW_TURN_SEPARATOR, renderRawTurn } from '../rendering/raw-turn-renderer.js';
import { escapeShellSyntax, stripShellSyntax } from '../security/sanitize.js';
import type { ParsedTurn, SummarizationOutput, ToolName, TurnDecision } from '../types/index.js';
import { DurableCaptureStore } from './durable-capture-store.js';
import { firstPromptSearch } from './first-prompt-search.js';
import type { SessionStore } from './session-store.js';
import { sourceTurnDigest } from './source-turn-digest.js';
import { TurnSearchIndex } from './turn-search-index.js';

// Rule 3 for a per-turn decision. Both fields take the ESCAPE policy, not
// strip: a decision may legitimately need to name the syntax it ruled out.
// `why` stays null when the transcript gave no reason.
export function sanitizeTurnDecision(d: TurnDecision): TurnDecision {
    return { what: escapeShellSyntax(d.what), why: d.why === null ? null : escapeShellSyntax(d.why) };
}

// Reads a stored decisions column, which holds EITHER the current
// `{what, why}` objects or the bare strings every row written before per-turn
// rationale capture used. Legacy strings become `why: null`, which is the
// truth about them: no reason was ever captured, and the rationale those rows
// appear to have was manufactured downstream by the rollup model.
//
// Migrating the column in place was the alternative and it would be a lie -
// it would have to invent the `why` it is supposed to be recording.
export function hydrateTurnDecisions(raw: string): TurnDecision[] {
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return [];
    }
    if (!Array.isArray(parsed)) {
        return [];
    }
    return parsed.flatMap((d) => {
        if (typeof d === 'string') {
            return [{ what: d, why: null }];
        }
        if (d && typeof d === 'object' && typeof (d as { what?: unknown }).what === 'string') {
            const rec = d as { what: string; why?: unknown };
            return [{ what: rec.what, why: typeof rec.why === 'string' && rec.why.trim() !== '' ? rec.why : null }];
        }
        return [];
    });
}

export interface MemoryRow {
    id: number;
    project_id: number;
    session_id: number;
    turn_index: number;
    tool: ToolName;
    turn_started_at: string;
    decisions: TurnDecision[];
    files_touched: string[];
    pending_items: string[];
    superseded_at: string | null;
    created_at: string;
    summarizer_status: string;
    reingested_at: string | null;
}

const INSERT_MEMORY_SQL = `INSERT OR IGNORE INTO memories
           (project_id, session_id, turn_index, tool, turn_started_at, decisions, files_touched, pending_items, created_at, summarizer_status, has_external_content)
         VALUES (@project_id, @session_id, @turn_index, @tool, @turn_started_at, @decisions, @files_touched, @pending_items, @now, @summarizer_status, @has_external_content)`;

const FIRST_PROMPT_SEARCH_IF_FIRST_SQL = `UPDATE sessions SET first_prompt_search = ?
                 WHERE id = ? AND first_prompt_search IS NULL
                   AND ? = (SELECT MIN(turn_index) FROM memories WHERE session_id = ?)`;

// Row-scoped cleanup never blocks the rest of the native transcript.

// Source identity a later replay can check this memory against, for the
// adapters that key turns by a stable source identity.
function recordSourceIdentity(db: Database, memoryId: number | bigint, turn: ParsedTurn): void {
    if (turn.sourceKey === undefined) {
        return;
    }
    db.prepare('UPDATE memories SET source_digest = ?, provenance = ? WHERE id = ?').run(
        sourceTurnDigest(turn),
        JSON.stringify(
            turn.provenance
                ? {
                      protocolVersion: stripShellSyntax(turn.provenance.protocolVersion),
                      producerVersion: stripShellSyntax(turn.provenance.producerVersion),
                      modelAliases: turn.provenance.modelAliases.map(stripShellSyntax),
                  }
                : null,
        ),
        memoryId,
    );
}

function incrementRenderedStats(db: Database, sessionDbId: number, turn: ParsedTurn): void {
    const stats = db.prepare('SELECT rendered_chars, rendered_turns FROM sessions WHERE id = ?').get(sessionDbId) as {
        rendered_chars: number | null;
        rendered_turns: number | null;
    };
    const rendered = renderRawTurn(turn, (stats.rendered_turns ?? 0) + 1);
    if (rendered !== null) {
        db.prepare(
            `UPDATE sessions
             SET rendered_chars = CASE WHEN rendered_chars IS NULL OR rendered_chars = 0 THEN ? ELSE rendered_chars + ? END,
                 rendered_turns = CASE WHEN rendered_turns IS NULL THEN NULL ELSE rendered_turns + 1 END
             WHERE id = ?`,
        ).run(rendered.length + 1, rendered.length + RAW_TURN_SEPARATOR.length, sessionDbId);
    }
}

export class TurnStore {
    private readonly durableCapture: DurableCaptureStore;
    private readonly turnSearch: TurnSearchIndex;
    private readonly stmts: {
        insertMemory: Statement;
        reingestMemory: Statement;
        memoryIdForTurn: Statement;
        deleteFilteredTurn: Statement;
        hasMemoryForNativeTurn: Statement;
        isTranscriptCaptureBlocked: Statement;
        ensureSourceGeneration: Statement;
        listRecentMemories: Statement;
        setFirstPromptSearch: Statement;
        reingestFirstPromptSearch: Statement;
    };

    constructor(
        private readonly db: Database,
        private readonly sessions: SessionStore,
    ) {
        this.durableCapture = new DurableCaptureStore(db);
        this.turnSearch = new TurnSearchIndex(db);
        this.stmts = {
            insertMemory: db.prepare(INSERT_MEMORY_SQL),
            // Reingest path: overwrites an existing row instead of ignoring the
            // conflict, so a naive re-run can't silently no-op against rows
            // already occupying (session_id, turn_index) from the broken
            // pipeline. Never
            // touches sessions.cursor - reingest is orthogonal to the live
            // daemon's forward-ingestion cursor, safe to run alongside it.
            reingestMemory: db.prepare(
                `INSERT INTO memories
           (project_id, session_id, turn_index, tool, turn_started_at, decisions, files_touched, pending_items, created_at, summarizer_status, reingested_at, has_external_content)
         VALUES (@project_id, @session_id, @turn_index, @tool, @turn_started_at, @decisions, @files_touched, @pending_items, @now, @summarizer_status, @now, @has_external_content)
         ON CONFLICT (session_id, turn_index) DO UPDATE SET
           decisions = excluded.decisions,
           files_touched = excluded.files_touched,
           pending_items = excluded.pending_items,
           summarizer_status = excluded.summarizer_status,
           reingested_at = excluded.reingested_at,
           has_external_content = excluded.has_external_content`,
            ),
            memoryIdForTurn: db.prepare('SELECT id FROM memories WHERE session_id = ? AND turn_index = ?'),
            deleteFilteredTurn: db.prepare('DELETE FROM filtered_turns WHERE memory_id = ?'),
            hasMemoryForNativeTurn: db.prepare(
                `SELECT 1 FROM memories m
         JOIN sessions s ON s.id = m.session_id
         WHERE s.tool = ? AND s.native_id = ? AND m.turn_index = ?
         LIMIT 1`,
            ),
            // A purge and an automatic retention removal both keep this native session from being captured again.
            isTranscriptCaptureBlocked: db.prepare(
                `SELECT 1 FROM purged_transcripts WHERE tool = @tool AND native_id = @nativeId
                 UNION ALL SELECT 1 FROM live_memory_retention_removals WHERE tool = @tool AND native_id = @nativeId`,
            ),
            // The first captured turn records the native session's starting source
            // generation, so retention can tell a known generation from a missing one.
            ensureSourceGeneration: db.prepare('INSERT OR IGNORE INTO source_generations (tool, native_id, generation) VALUES (?, ?, 0)'),
            listRecentMemories: db.prepare('SELECT * FROM memories WHERE project_id = ? ORDER BY turn_started_at DESC LIMIT ?'),
            setFirstPromptSearch: db.prepare(FIRST_PROMPT_SEARCH_IF_FIRST_SQL),
            reingestFirstPromptSearch: db.prepare(
                `UPDATE sessions SET first_prompt_search = ?
                 WHERE id = ? AND ? = (SELECT MIN(turn_index) FROM memories WHERE session_id = ?)`,
            ),
        };
    }

    // Source turn indexes remain native-file-global across segments. This
    // protects a whole already-processed batch being replayed after a cut:
    // UNIQUE(session_id, turn_index) alone cannot see that turn N lives in an
    // older segment. It is a dedupe lookup only; boundary evidence still comes
    // exclusively from the active session row.
    hasMemoryForNativeTurn(tool: ToolName, nativeId: string, turnIndex: number): boolean {
        return this.stmts.hasMemoryForNativeTurn.get(tool, nativeId, turnIndex) !== undefined;
    }

    // Latest turn timestamp, which is the actual-ingestion signal for status.
    getLastIngestedAt(): string | undefined {
        const row = this.db.prepare('SELECT MAX(turn_started_at) as last FROM memories').get() as { last: string | null };
        return row.last ?? undefined;
    }

    // Persists one turn's summary and advances the session cursor in a single
    // transaction. This is the live-ingestion path only - INSERT OR IGNORE on
    // UNIQUE(session_id, turn_index) makes a duplicate scan of an
    // already-stored turn from overlapping watch events, a
    // no-op instead of a duplicate row, safe only because the cursor advance
    // is atomic with it (a two-statement version turns this dedupe guard into
    // silent data loss). For deliberately overwriting an already-stored turn
    // with a re-summarized result, use reingestTurn instead - IGNORE here
    // would silently discard the fix.
    recordTurn(turn: ParsedTurn, sessionDbId: number, projectId: number, summary: SummarizationOutput, durableCapture = false): boolean {
        const run = this.db.transaction(() => this.recordTurnInTransaction(turn, sessionDbId, projectId, summary, durableCapture));
        return run();
    }

    // Records a live turn while an enclosing ingestion transaction owns its session row.
    recordTurnInTransaction(
        turn: ParsedTurn,
        sessionDbId: number,
        projectId: number,
        summary: SummarizationOutput,
        durableCapture = false,
    ): boolean {
        if (turn.droppedReason !== undefined) {
            return false;
        }

        if (this.stmts.isTranscriptCaptureBlocked.get({ tool: turn.tool, nativeId: turn.sessionId }) !== undefined) {
            return false;
        }
        const now = new Date().toISOString();
        const info = this.stmts.insertMemory.run({
            project_id: projectId,
            session_id: sessionDbId,
            turn_index: turn.turnIndex,
            tool: turn.tool,
            turn_started_at: turn.startedAt,
            decisions: JSON.stringify(summary.decisions.map(sanitizeTurnDecision)),
            files_touched: JSON.stringify(dedupePaths(turn.toolCalls.flatMap((c) => c.filePaths))),
            pending_items: JSON.stringify(summary.pending_items.map(stripShellSyntax)),
            now,
            summarizer_status: summary.status,
            has_external_content: turn.hasExternalContent ? 1 : 0,
        });
        if (info.changes > 0) {
            this.stmts.ensureSourceGeneration.run(turn.tool, turn.sessionId);
        }
        if (info.changes > 0) {
            recordSourceIdentity(this.db, info.lastInsertRowid, turn);
        }
        // A coverage row exists only for a retained copy. With capture off, or
        // when a legacy eviction refuses the copy, the turn stays unindexed: a
        // visible coverage gap rather than a hit on transcript-only text.
        if (
            info.changes > 0 &&
            durableCapture &&
            this.durableCapture.record(info.lastInsertRowid, sessionDbId, filterTurn(turn), now) === 'retained'
        ) {
            this.turnSearch.record(info.lastInsertRowid, turn, now);
            this.durableCapture.refreshStatus(sessionDbId, now);
        }
        this.sessions.advanceSessionCursorAt(sessionDbId, turn, now);
        this.sessions.updateTrailingState(sessionDbId, turn);
        if (info.changes > 0) {
            this.stmts.setFirstPromptSearch.run(firstPromptSearch(turn.userMessage), sessionDbId, turn.turnIndex, sessionDbId);
            this.sessions.updateSessionTitle(sessionDbId, turn);
            incrementRenderedStats(this.db, sessionDbId, turn);
        }
        return info.changes > 0;
    }

    // Overwrites an existing (session_id, turn_index) row with a fresh
    // summary - the `elepha reingest` maintenance path. Deliberately does NOT
    // touch sessions.cursor: reingest re-derives turns from byte 0 of the
    // source file independently of the live daemon's forward cursor, and
    // must never regress or advance it. Uses INSERT ... ON CONFLICT DO UPDATE
    // rather than delete-then-insert so there is no window where the row is
    // gone - a crash mid-reingest leaves either the old or the new value,
    // never neither.
    //
    // The filtered copy and its coverage row are replaced in the same
    // transaction. When no replacement can be retained (capture off, or a
    // legacy eviction) the old coverage is withdrawn; an old copy stays stored
    // but predates reingested_at, so readers report it as stale, never current.
    reingestTurn(turn: ParsedTurn, sessionDbId: number, projectId: number, summary: SummarizationOutput, durableCapture = false): void {
        if (turn.droppedReason !== undefined) {
            throw new Error('dropped turns cannot be written as memories');
        }

        const now = new Date().toISOString();
        this.stmts.reingestMemory.run({
            project_id: projectId,
            session_id: sessionDbId,
            turn_index: turn.turnIndex,
            tool: turn.tool,
            turn_started_at: turn.startedAt,
            decisions: JSON.stringify(summary.decisions.map(sanitizeTurnDecision)),
            files_touched: JSON.stringify(dedupePaths(turn.toolCalls.flatMap((c) => c.filePaths))),
            pending_items: JSON.stringify(summary.pending_items.map(stripShellSyntax)),
            now,
            summarizer_status: summary.status,
            has_external_content: turn.hasExternalContent ? 1 : 0,
        });
        // ON CONFLICT DO UPDATE keeps the existing id but does not report it.
        const memory = this.stmts.memoryIdForTurn.get(sessionDbId, turn.turnIndex) as { id: number };
        this.turnSearch.withdraw(memory.id);
        if (durableCapture) {
            this.stmts.deleteFilteredTurn.run(memory.id);
            if (this.durableCapture.record(memory.id, sessionDbId, filterTurn(turn), now) === 'retained') {
                this.turnSearch.record(memory.id, turn, now);
                this.durableCapture.refreshStatus(sessionDbId, now);
            }
        }
        this.stmts.reingestFirstPromptSearch.run(firstPromptSearch(turn.userMessage), sessionDbId, turn.turnIndex, sessionDbId);
    }

    // Every turn of one session, in turn order - the rollup input.
    listMemoriesForSession(sessionId: number): MemoryRow[] {
        const rows = this.db.prepare('SELECT * FROM memories WHERE session_id = ? ORDER BY turn_index').all(sessionId) as Array<
            Omit<MemoryRow, 'decisions' | 'files_touched' | 'pending_items'> & Record<string, string>
        >;
        return rows.map((r) => ({
            ...r,
            decisions: hydrateTurnDecisions(r.decisions),
            files_touched: JSON.parse(r.files_touched),
            pending_items: JSON.parse(r.pending_items),
        })) as MemoryRow[];
    }

    listRecentMemories(projectId: number, limit = 20): MemoryRow[] {
        const rows = this.stmts.listRecentMemories.all(projectId, limit) as Array<
            Omit<MemoryRow, 'decisions' | 'files_touched' | 'pending_items'> & {
                decisions: string;
                files_touched: string;
                pending_items: string;
            }
        >;
        return rows.map((r) => ({
            ...r,
            decisions: hydrateTurnDecisions(r.decisions),
            files_touched: JSON.parse(r.files_touched),
            pending_items: JSON.parse(r.pending_items),
        }));
    }
}
