// Recomputes sessions.rendered_chars and sessions.rendered_turns from the same
// raw-turn renderer used at ingestion. It is transcript-only: no summarizer
// call and no retained text.

import type { Database } from 'better-sqlite3';
import { isReadableProviderSource } from '../config/paths.js';
import { renderedChars, renderedTurns } from '../rendering/raw-turn-renderer.js';
import type { ParsedTurn, SessionAdapter, ToolName } from '../types/index.js';
import { applyBackfill, type BackfillDeriver, planBackfill } from './backfill-runner.js';

export interface RenderedCharsChange {
    sessionId: number;
    tool: ToolName;
    nativeId: string;
    sourcePath: string;
    beforeRenderedChars: number | null;
    beforeRenderedTurns: number | null;
    renderedChars: number | null;
    renderedTurns: number | null;
    transcriptMissing: boolean;
}

export interface RenderedCharsPlan {
    changes: RenderedCharsChange[];
    sessionsScanned: number;
    sessionsMissingTranscript: number;
    sessionsSkippedConcurrent: number;
}

interface SessionSeed {
    id: number;
    tool: ToolName;
    native_id: string;
    source_path: string;
    rendered_chars: number | null;
    rendered_turns: number | null;
}

async function countSession(
    session: SessionSeed,
    adapter: SessionAdapter,
    turnIndexes: Set<number>,
): Promise<{ renderedChars: number; renderedTurns: number } | null> {
    if (!isReadableProviderSource(session.tool, session.source_path)) {
        return null;
    }

    const turns: ParsedTurn[] = [];
    try {
        for await (const turn of adapter.parseTurns(session.source_path, undefined, { closeTrailingOnIdle: true })) {
            if (turnIndexes.has(turn.turnIndex)) {
                turns.push(turn);
            }
        }
    } catch {
        return null;
    }

    // A retained row the current adapter cannot re-produce is an unavailable
    // transcript, not a legitimate zero-byte render. NULL keeps that visible.
    if (turns.length !== turnIndexes.size) {
        return null;
    }
    turns.sort((left, right) => left.turnIndex - right.turnIndex);
    return { renderedChars: renderedChars(turns), renderedTurns: renderedTurns(turns) };
}

const deriver: BackfillDeriver<SessionSeed, RenderedCharsChange, Map<number, Set<number>>> = {
    load(db) {
        const sessions = db
            .prepare('SELECT id, tool, native_id, source_path, rendered_chars, rendered_turns FROM sessions ORDER BY id')
            .all() as SessionSeed[];
        const turnRows = db.prepare('SELECT session_id, turn_index FROM memories ORDER BY session_id, turn_index').all() as Array<{
            session_id: number;
            turn_index: number;
        }>;
        const indexesBySession = new Map<number, Set<number>>();
        for (const row of turnRows) {
            const indexes = indexesBySession.get(row.session_id) ?? new Set<number>();
            indexes.add(row.turn_index);
            indexesBySession.set(row.session_id, indexes);
        }
        return { sessions, state: indexesBySession };
    },
    async derive({ adapters, session, state }) {
        const counted = await countSession(session, adapters[session.tool], state.get(session.id) ?? new Set());
        const transcriptMissing = counted === null;
        if (!transcriptMissing && session.rendered_chars === counted.renderedChars && session.rendered_turns === counted.renderedTurns) {
            return undefined;
        }
        return {
            sessionId: session.id,
            tool: session.tool,
            nativeId: session.native_id,
            sourcePath: session.source_path,
            beforeRenderedChars: session.rendered_chars,
            beforeRenderedTurns: session.rendered_turns,
            renderedChars: counted?.renderedChars ?? null,
            renderedTurns: counted?.renderedTurns ?? null,
            transcriptMissing,
        };
    },
    shouldWrite: () => true,
    write(db, change) {
        // The daemon may append while this transcript-only pass is reading.
        // Never overwrite a row whose stats changed after the plan snapshot;
        // post-verification will surface it for the next bounded retry.
        const result = db
            .prepare(
                `UPDATE sessions SET rendered_chars = ?, rendered_turns = ?
                 WHERE id = ? AND rendered_chars IS ? AND rendered_turns IS ?`,
            )
            .run(change.renderedChars, change.renderedTurns, change.sessionId, change.beforeRenderedChars, change.beforeRenderedTurns);
        return { sessionsSkippedConcurrent: result.changes === 0 ? 1 : 0 };
    },
    recordConcurrentSkips(plan, skipped) {
        (plan as RenderedCharsPlan).sessionsSkippedConcurrent = skipped;
    },
};

export async function planRenderedCharsBackfill(db: Database, adapters: Record<ToolName, SessionAdapter>): Promise<RenderedCharsPlan> {
    const plan = await planBackfill(db, adapters, deriver);
    return { ...plan, sessionsSkippedConcurrent: 0 };
}

export async function applyRenderedCharsBackfill(db: Database, adapters: Record<ToolName, SessionAdapter>): Promise<RenderedCharsPlan> {
    const plan = await applyBackfill(db, adapters, deriver);
    return { ...plan, sessionsSkippedConcurrent: (plan as Partial<RenderedCharsPlan>).sessionsSkippedConcurrent ?? 0 };
}
