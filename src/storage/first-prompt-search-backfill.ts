// Re-derives the bounded body-search document for each stored segment from
// its first retained turn. It never changes turns, boundaries, or rollups.

import type { Database } from 'better-sqlite3';
import { isReadableProviderSource } from '../config/paths.js';
import type { SessionAdapter, ToolName } from '../types/index.js';
import { applyBackfill, type BackfillDeriver, planBackfill } from './backfill-runner.js';
import { firstPromptSearch } from './first-prompt-search.js';

export interface FirstPromptSearchChange {
    sessionId: number;
    nativeId: string;
    tool: ToolName;
    sourcePath: string;
    before: string | null;
    after: string | null;
    transcriptMissing: boolean;
}

export interface FirstPromptSearchPlan {
    changes: FirstPromptSearchChange[];
    sessionsScanned: number;
    sessionsMissingTranscript: number;
}

export interface FirstPromptSearchBackfillScope {
    /** Limits daemon-owned work to one bounded batch; omitted by the repair CLI. */
    sessionIds: readonly number[];
    /** Prevents background repair from replacing a value written concurrently by ingestion. */
    onlyNull: boolean;
    /** Rechecks daemon-owned authorization inside the transaction immediately before a write. */
    authorizeWrite?: (db: Database, sessionId: number) => boolean;
}

interface SessionSeed {
    id: number;
    tool: ToolName;
    native_id: string;
    source_path: string;
    first_prompt_search: string | null;
}

async function deriveFirstPrompt(session: SessionSeed, adapter: SessionAdapter, firstStoredIndex: number): Promise<string | undefined> {
    if (!isReadableProviderSource(session.tool, session.source_path)) {
        return undefined;
    }
    try {
        for await (const turn of adapter.parseTurns(session.source_path, undefined, { closeTrailingOnIdle: true })) {
            if (turn.turnIndex === firstStoredIndex) {
                return firstPromptSearch(turn.userMessage);
            }
        }
    } catch {
        return undefined;
    }
    return undefined;
}

const deriver: BackfillDeriver<SessionSeed, FirstPromptSearchChange, Map<number, number>> = {
    load(db) {
        const sessions = db
            .prepare('SELECT id, tool, native_id, source_path, first_prompt_search FROM sessions ORDER BY id')
            .all() as SessionSeed[];
        const firstIndexes = db
            .prepare('SELECT session_id, MIN(turn_index) AS turn_index FROM memories GROUP BY session_id')
            .all() as Array<{ session_id: number; turn_index: number }>;
        return { sessions, state: new Map(firstIndexes.map((row) => [row.session_id, row.turn_index])) };
    },
    async derive({ adapters, session, state }) {
        const firstStoredIndex = state.get(session.id);
        if (firstStoredIndex === undefined) {
            return undefined;
        }
        const after = await deriveFirstPrompt(session, adapters[session.tool], firstStoredIndex);
        if (after === undefined) {
            return {
                sessionId: session.id,
                nativeId: session.native_id,
                tool: session.tool,
                sourcePath: session.source_path,
                before: session.first_prompt_search,
                after: session.first_prompt_search,
                transcriptMissing: true,
            };
        }
        if (session.first_prompt_search === after) {
            return undefined;
        }
        return {
            sessionId: session.id,
            nativeId: session.native_id,
            tool: session.tool,
            sourcePath: session.source_path,
            before: session.first_prompt_search,
            after,
            transcriptMissing: false,
        };
    },
    shouldWrite: (change) => !change.transcriptMissing,
    write(db, change) {
        db.prepare('UPDATE sessions SET first_prompt_search = ? WHERE id = ?').run(change.after, change.sessionId);
        return {};
    },
};

function daemonBatchDeriver(
    scope: FirstPromptSearchBackfillScope,
): BackfillDeriver<SessionSeed, FirstPromptSearchChange, Map<number, number>> {
    return {
        ...deriver,
        load(db) {
            if (scope.sessionIds.length === 0) {
                return { sessions: [], state: new Map() };
            }
            const placeholders = scope.sessionIds.map(() => '?').join(', ');
            const nullClause = scope.onlyNull ? ' AND first_prompt_search IS NULL' : '';
            const sessions = db
                .prepare(
                    `SELECT id, tool, native_id, source_path, first_prompt_search
                     FROM sessions
                     WHERE id IN (${placeholders})${nullClause}
                     ORDER BY id`,
                )
                .all(...scope.sessionIds) as SessionSeed[];
            const firstIndexes = db
                .prepare(
                    `SELECT session_id, MIN(turn_index) AS turn_index
                     FROM memories
                     WHERE session_id IN (${placeholders})
                     GROUP BY session_id`,
                )
                .all(...scope.sessionIds) as Array<{ session_id: number; turn_index: number }>;
            return { sessions, state: new Map(firstIndexes.map((row) => [row.session_id, row.turn_index])) };
        },
        write(db, change) {
            if (scope.authorizeWrite?.(db, change.sessionId) === false) {
                return {};
            }
            const nullClause = scope.onlyNull ? ' AND first_prompt_search IS NULL' : '';
            db.prepare(`UPDATE sessions SET first_prompt_search = ? WHERE id = ?${nullClause}`).run(change.after, change.sessionId);
            return {};
        },
    };
}

/** Shows first-prompt search changes without writing. */
export async function planFirstPromptSearchBackfill(
    db: Database,
    adapters: Record<ToolName, SessionAdapter>,
    scope?: FirstPromptSearchBackfillScope,
): Promise<FirstPromptSearchPlan> {
    return planBackfill(db, adapters, scope === undefined ? deriver : daemonBatchDeriver(scope));
}

/** Applies only readable sessions' derived first-prompt search documents in one transaction. */
export async function applyFirstPromptSearchBackfill(
    db: Database,
    adapters: Record<ToolName, SessionAdapter>,
    scope?: FirstPromptSearchBackfillScope,
): Promise<FirstPromptSearchPlan> {
    return applyBackfill(db, adapters, scope === undefined ? deriver : daemonBatchDeriver(scope));
}
