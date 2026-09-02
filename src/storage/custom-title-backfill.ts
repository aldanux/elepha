// Backfill Claude Code's standalone custom-title UI event into
// sessions.custom_title. It never parses or rewrites turns, memories, rollups,
// rendered output, or rendered_chars.

import type { Database } from 'better-sqlite3';
import { isReadableProviderSource } from '../config/paths.js';
import type { SessionAdapter, ToolName } from '../types/index.js';
import { applyBackfill, type BackfillDeriver, planBackfill } from './backfill-runner.js';

export interface CustomTitleChange {
    sessionId: number;
    nativeId: string;
    tool: ToolName;
    sourcePath: string;
    before: string | null;
    after: string | null;
    transcriptMissing: boolean;
}

export interface CustomTitlePlan {
    changes: CustomTitleChange[];
    sessionsScanned: number;
    sessionsMissingTranscript: number;
}

interface SessionSeed {
    id: number;
    tool: ToolName;
    native_id: string;
    source_path: string;
    custom_title: string | null;
}

const deriver: BackfillDeriver<SessionSeed, CustomTitleChange> = {
    load(db) {
        return {
            sessions: db.prepare('SELECT id, tool, native_id, source_path, custom_title FROM sessions').all() as SessionSeed[],
            state: undefined,
        };
    },
    async derive({ adapters, session }) {
        if (!isReadableProviderSource(session.tool, session.source_path)) {
            return {
                sessionId: session.id,
                nativeId: session.native_id,
                tool: session.tool,
                sourcePath: session.source_path,
                before: session.custom_title,
                after: session.custom_title,
                transcriptMissing: true,
            };
        }

        let title: string | undefined;
        try {
            title = (await adapters[session.tool].readCustomTitle?.(session.source_path))?.customTitle;
        } catch {
            return {
                sessionId: session.id,
                nativeId: session.native_id,
                tool: session.tool,
                sourcePath: session.source_path,
                before: session.custom_title,
                after: session.custom_title,
                transcriptMissing: true,
            };
        }

        const after = title ?? null;
        if (session.custom_title === after) {
            return undefined;
        }
        return {
            sessionId: session.id,
            nativeId: session.native_id,
            tool: session.tool,
            sourcePath: session.source_path,
            before: session.custom_title,
            after,
            transcriptMissing: false,
        };
    },
    shouldWrite: (change) => !change.transcriptMissing,
    write(db, change) {
        db.prepare('UPDATE sessions SET custom_title = ? WHERE id = ?').run(change.after, change.sessionId);
        return {};
    },
};

export async function planCustomTitleBackfill(db: Database, adapters: Record<ToolName, SessionAdapter>): Promise<CustomTitlePlan> {
    return planBackfill(db, adapters, deriver);
}

// Applies only planned custom_title changes in one transaction.
export async function applyCustomTitleBackfill(db: Database, adapters: Record<ToolName, SessionAdapter>): Promise<CustomTitlePlan> {
    return applyBackfill(db, adapters, deriver);
}
