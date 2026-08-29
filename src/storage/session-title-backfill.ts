// Re-derives the stored list_sessions title for every existing segment from
// its already-persisted turn indexes. This never changes segment boundaries,
// memories, rollups, rendered statistics, or custom-title metadata.

import type { Database } from 'better-sqlite3';
import { isReadableProviderSource } from '../config/paths.js';
import type { ParsedTurn, SessionAdapter, ToolName } from '../types/index.js';
import { applyBackfill, type BackfillDeriver, planBackfill } from './backfill-runner.js';
import { titleForSegment } from './session-title.js';

export interface SessionTitleChange {
    sessionId: number;
    nativeId: string;
    tool: ToolName;
    sourcePath: string;
    before: string | null;
    after: string | null;
    transcriptMissing: boolean;
}

export interface SessionTitlePlan {
    changes: SessionTitleChange[];
    sessionsScanned: number;
    sessionsMissingTranscript: number;
}

interface SessionSeed {
    id: number;
    tool: ToolName;
    native_id: string;
    source_path: string;
    segment_index: number;
    title: string | null;
}

async function turnsForSession(db: Database, session: SessionSeed, adapter: SessionAdapter): Promise<ParsedTurn[] | undefined> {
    if (!isReadableProviderSource(session.tool, session.source_path)) {
        return undefined;
    }
    const indexes = new Set(
        (
            db.prepare('SELECT turn_index FROM memories WHERE session_id = ? ORDER BY turn_index').all(session.id) as Array<{
                turn_index: number;
            }>
        ).map((row) => row.turn_index),
    );
    const turns: ParsedTurn[] = [];
    try {
        for await (const turn of adapter.parseTurns(session.source_path, undefined, { closeTrailingOnIdle: true })) {
            if (indexes.has(turn.turnIndex)) {
                turns.push(turn);
            }
        }
    } catch {
        return undefined;
    }
    return turns;
}

const deriver: BackfillDeriver<SessionSeed, SessionTitleChange> = {
    load(db) {
        return {
            sessions: db
                .prepare('SELECT id, tool, native_id, source_path, segment_index, title FROM sessions ORDER BY id')
                .all() as SessionSeed[],
            state: undefined,
        };
    },
    async derive({ db, adapters, session }) {
        const turns = await turnsForSession(db, session, adapters[session.tool]);
        if (turns === undefined) {
            return {
                sessionId: session.id,
                nativeId: session.native_id,
                tool: session.tool,
                sourcePath: session.source_path,
                before: session.title,
                after: session.title,
                transcriptMissing: true,
            };
        }

        const after = titleForSegment(turns, session.segment_index === 0);
        if (session.title === after) {
            return undefined;
        }
        return {
            sessionId: session.id,
            nativeId: session.native_id,
            tool: session.tool,
            sourcePath: session.source_path,
            before: session.title,
            after,
            transcriptMissing: false,
        };
    },
    shouldWrite: (change) => !change.transcriptMissing,
    write(db, change) {
        db.prepare('UPDATE sessions SET title = ? WHERE id = ?').run(change.after, change.sessionId);
        return {};
    },
};

/** Shows title changes without writing. */
export async function planSessionTitleBackfill(db: Database, adapters: Record<ToolName, SessionAdapter>): Promise<SessionTitlePlan> {
    return planBackfill(db, adapters, deriver);
}

/** Applies only readable sessions' derived titles in one transaction. */
export async function applySessionTitleBackfill(db: Database, adapters: Record<ToolName, SessionAdapter>): Promise<SessionTitlePlan> {
    return applyBackfill(db, adapters, deriver);
}
