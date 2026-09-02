import type { Database, Statement } from 'better-sqlite3';
import { dedupePaths } from '../config/paths.js';
import { RAW_TURN_SEPARATOR, renderRawTurn } from '../rendering/raw-turn-renderer.js';
import { escapeShellSyntax, stripShellSyntax } from '../security/sanitize.js';
import type { ParsedTurn, SummarizationOutput, ToolName, TurnDecision } from '../types/index.js';
import { firstPromptSearch } from './first-prompt-search.js';
import type { SessionStore } from './session-store.js';

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

export class TurnStore {
    private readonly stmts: {
        insertMemory: Statement;
        reingestMemory: Statement;
        hasMemoryForNativeTurn: Statement;
        isTranscriptPurged: Statement;
        listRecentMemories: Statement;
        renderedStats: Statement;
        incrementRenderedStats: Statement;
        setFirstPromptSearch: Statement;
        reingestFirstPromptSearch: Statement;
    };

    constructor(
        private readonly db: Database,
        private readonly sessions: SessionStore,
    ) {
        this.stmts = {
            insertMemory: db.prepare(
                `INSERT OR IGNORE INTO memories
           (project_id, session_id, turn_index, tool, turn_started_at, decisions, files_touched, pending_items, created_at, summarizer_status, has_external_content)
         VALUES (@project_id, @session_id, @turn_index, @tool, @turn_started_at, @decisions, @files_touched, @pending_items, @now, @summarizer_status, @has_external_content)`,
            ),
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
            hasMemoryForNativeTurn: db.prepare(
                `SELECT 1 FROM memories m
         JOIN sessions s ON s.id = m.session_id
         WHERE s.tool = ? AND s.native_id = ? AND m.turn_index = ?
         LIMIT 1`,
            ),
            isTranscriptPurged: db.prepare('SELECT 1 FROM purged_transcripts WHERE tool = ? AND native_id = ?'),
            listRecentMemories: db.prepare('SELECT * FROM memories WHERE project_id = ? ORDER BY turn_started_at DESC LIMIT ?'),
            renderedStats: db.prepare('SELECT rendered_chars, rendered_turns FROM sessions WHERE id = ?'),
            incrementRenderedStats: db.prepare(
                `UPDATE sessions
                 SET rendered_chars = CASE WHEN rendered_chars IS NULL OR rendered_chars = 0 THEN ? ELSE rendered_chars + ? END,
                     rendered_turns = CASE WHEN rendered_turns IS NULL THEN NULL ELSE rendered_turns + 1 END
                 WHERE id = ?`,
            ),
            setFirstPromptSearch: db.prepare(
                `UPDATE sessions SET first_prompt_search = ?
                 WHERE id = ? AND first_prompt_search IS NULL
                   AND ? = (SELECT MIN(turn_index) FROM memories WHERE session_id = ?)`,
            ),
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
    recordTurn(turn: ParsedTurn, sessionDbId: number, projectId: number, summary: SummarizationOutput): boolean {
        const run = this.db.transaction(() => this.recordTurnInTransaction(turn, sessionDbId, projectId, summary));
        return run();
    }

    // Records a live turn while an enclosing ingestion transaction owns its session row.
    recordTurnInTransaction(turn: ParsedTurn, sessionDbId: number, projectId: number, summary: SummarizationOutput): boolean {
        if (this.stmts.isTranscriptPurged.get(turn.tool, turn.sessionId) !== undefined) {
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
        this.sessions.advanceSessionCursorAt(sessionDbId, turn.cursor, now);
        this.sessions.updateTrailingState(sessionDbId, turn);
        if (info.changes > 0) {
            this.stmts.setFirstPromptSearch.run(firstPromptSearch(turn.userMessage), sessionDbId, turn.turnIndex, sessionDbId);
            this.sessions.updateSessionTitle(sessionDbId, turn);
            this.recordRenderedTurn(sessionDbId, turn);
        }
        return info.changes > 0;
    }

    private recordRenderedTurn(sessionDbId: number, turn: ParsedTurn): void {
        const stats = this.stmts.renderedStats.get(sessionDbId) as {
            rendered_chars: number | null;
            rendered_turns: number | null;
        };
        const rendered = renderRawTurn(turn, (stats.rendered_turns ?? 0) + 1);
        if (rendered !== null) {
            this.stmts.incrementRenderedStats.run(rendered.length + 1, rendered.length + RAW_TURN_SEPARATOR.length, sessionDbId);
        }
    }

    // Overwrites an existing (session_id, turn_index) row with a fresh
    // summary - the `elepha reingest` maintenance path. Deliberately does NOT
    // touch sessions.cursor: reingest re-derives turns from byte 0 of the
    // source file independently of the live daemon's forward cursor, and
    // must never regress or advance it. Uses INSERT ... ON CONFLICT DO UPDATE
    // rather than delete-then-insert so there is no window where the row is
    // gone - a crash mid-reingest leaves either the old or the new value,
    // never neither.
    reingestTurn(turn: ParsedTurn, sessionDbId: number, projectId: number, summary: SummarizationOutput): void {
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
