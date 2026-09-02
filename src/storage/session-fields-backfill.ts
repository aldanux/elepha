// Backfill: re-derives surface/git_branch/kind/trailing_branch/
// trailing_files (sessions) and has_external_content (memories) for rows
// that predate capture-at-ingestion, from transcripts
// still on disk. Structural only - re-walks each session's file through its
// adapter's parseTurns(), which never calls a SummarizationProvider. This is
// NOT `elepha reingest`: no model call, no decisions/pending_items rewrite.
//
// Destructive-operation shape: preview (the list, not a
// count) -> --apply gate -> DB backup -> single transaction -> re-verify.
// A session whose source_path is outside its provider store, no longer exists,
// or exists but cannot actually be read (corrupted, permission-denied, deleted
// in a race after the readability check, a path pointing at a directory, ...), keeps every
// new field NULL - never a manufactured value. Both cases collapse into the
// same `transcriptMissing: true` outcome: the caller-facing behavior (NULL,
// shown in preview, exempted from the CLI verify check) is identical either
// way, and distinguishing "absent" from "present but unreadable" for
// reporting isn't worth the extra surface.

import type { Database } from 'better-sqlite3';
import { claudeCodeSurface, codexSurface, toSessionRowKind } from '../adapters/discriminators.js';
import { TRAILING_FILES_CAP } from '../config/constants.js';
import { dedupePaths, isReadableProviderSource } from '../config/paths.js';
import type { ParsedTurn, SessionAdapter, ToolName } from '../types/index.js';
import { applyBackfill, type BackfillDeriver, planBackfill } from './backfill-runner.js';

export interface SessionFieldsBefore {
    surface: string | null;
    git_branch: string | null;
    kind: string | null;
    trailing_branch: string | null;
    trailing_files: string;
}

export interface SessionFieldsChange {
    sessionId: number;
    nativeId: string;
    tool: ToolName;
    sourcePath: string;
    transcriptMissing: boolean;
    before: SessionFieldsBefore;
    after: SessionFieldsBefore;
    // Count of memories rows whose has_external_content flipped for this session.
    memoryFlagsChanged: number;
}

export interface SessionFieldsPlan {
    changes: SessionFieldsChange[];
    sessionsScanned: number;
    sessionsMissingTranscript: number;
}

interface SessionSeed {
    id: number;
    tool: ToolName;
    native_id: string;
    source_path: string;
    surface: string | null;
    git_branch: string | null;
    kind: string | null;
    trailing_branch: string | null;
    trailing_files: string;
}

// The NULL-preserving result: reused for both "doesn't exist" and "exists but couldn't actually be read".
function unreadableResult(session: SessionSeed): { after: SessionFieldsBefore; turns: ParsedTurn[]; transcriptMissing: boolean } {
    return {
        transcriptMissing: true,
        turns: [],
        after: {
            surface: session.surface,
            git_branch: session.git_branch,
            kind: session.kind,
            trailing_branch: session.trailing_branch,
            trailing_files: session.trailing_files,
        },
    };
}

async function deriveForSession(
    session: SessionSeed,
    adapter: SessionAdapter,
): Promise<{ after: SessionFieldsBefore; turns: ParsedTurn[]; transcriptMissing: boolean }> {
    if (!isReadableProviderSource(session.tool, session.source_path)) {
        return unreadableResult(session);
    }

    // The guarded file exists, but "exists" is not "readable":
    // classifySession/parseTurns can still throw - EISDIR (source_path points
    // at a directory), EACCES (permission denied), or a delete-after-exists
    // race. base.ts's parseTurns opens the file with `fs.promises.open`
    // outside any try/catch, so that throw is uncaught and would otherwise
    // propagate out of this async generator loop, out of buildPlan's
    // per-session loop, and abort the entire plan/apply run for every other
    // session in the batch - not just this one. Treat it exactly like a
    // missing file: NULL-preserving, reported, never a manufactured value.
    let classification: Awaited<ReturnType<SessionAdapter['classifySession']>>;
    const turns: ParsedTurn[] = [];
    try {
        classification = await adapter.classifySession(session.source_path);
        for await (const turn of adapter.parseTurns(session.source_path, undefined, { closeTrailingOnIdle: true })) {
            turns.push(turn);
        }
    } catch {
        return unreadableResult(session);
    }
    const kind = toSessionRowKind(classification.kind);

    const firstWithSurface = turns.find((t) => t.surface !== undefined);
    const firstWithBranch = turns.find((t) => t.gitBranch !== undefined);
    const lastWithBranch = [...turns].reverse().find((t) => t.gitBranch !== undefined);

    const rawSurface = firstWithSurface?.surface;
    const surface = session.tool === 'claude-code' ? claudeCodeSurface(rawSurface) : codexSurface(rawSurface);

    // trailing_files: most-recent-first across the re-parsed turns, same cap
    // and dedupe as the live updateTrailingState path (MemoryStore.recordTurn).
    const filesNewestFirst = [...turns].reverse().flatMap((t) => t.toolCalls.flatMap((c) => c.filePaths));
    const trailingFiles = dedupePaths(filesNewestFirst).slice(0, TRAILING_FILES_CAP);

    return {
        transcriptMissing: false,
        turns,
        after: {
            surface,
            git_branch: firstWithBranch?.gitBranch ?? null,
            kind,
            trailing_branch: lastWithBranch?.gitBranch ?? null,
            trailing_files: JSON.stringify(trailingFiles),
        },
    };
}

const deriver: BackfillDeriver<SessionSeed, SessionFieldsChange> = {
    load(db) {
        return {
            sessions: db
                .prepare(
                    'SELECT id, tool, native_id, source_path, surface, git_branch, kind, trailing_branch, trailing_files FROM sessions',
                )
                .all() as SessionSeed[],
            state: undefined,
        };
    },
    async derive({ db, adapters, session }) {
        const { after, turns, transcriptMissing } = await deriveForSession(session, adapters[session.tool]);
        const before: SessionFieldsBefore = {
            surface: session.surface,
            git_branch: session.git_branch,
            kind: session.kind,
            trailing_branch: session.trailing_branch,
            trailing_files: session.trailing_files,
        };

        let memoryFlagsChanged = 0;
        if (!transcriptMissing) {
            const existingMemories = db
                .prepare('SELECT turn_index, has_external_content FROM memories WHERE session_id = ?')
                .all(session.id) as Array<{ turn_index: number; has_external_content: number }>;
            const byIndex = new Map(existingMemories.map((memory) => [memory.turn_index, memory.has_external_content]));
            for (const turn of turns) {
                const want = turn.hasExternalContent ? 1 : 0;
                const have = byIndex.get(turn.turnIndex);
                if (have !== undefined && have !== want) {
                    memoryFlagsChanged++;
                }
            }
        }

        // transcriptMissing sessions are always reported, even though `after`
        // mirrors `before` verbatim (there's nothing to derive without the
        // file) - the operator needs visibility into "this session can never
        // be backfilled from disk" as distinct from "nothing to do here".
        // deriveForSession's NULL-preserving branch is what keeps the actual
        // apply() a no-op for these rows; this only affects what gets listed.
        const changed =
            before.surface !== after.surface ||
            before.git_branch !== after.git_branch ||
            before.kind !== after.kind ||
            before.trailing_branch !== after.trailing_branch ||
            before.trailing_files !== after.trailing_files ||
            memoryFlagsChanged > 0 ||
            transcriptMissing;
        if (!changed) {
            return undefined;
        }

        return {
            sessionId: session.id,
            nativeId: session.native_id,
            tool: session.tool,
            sourcePath: session.source_path,
            transcriptMissing,
            before,
            after,
            memoryFlagsChanged,
        };
    },
    shouldWrite: () => true,
    write(db, change) {
        db.prepare('UPDATE sessions SET surface = ?, git_branch = ?, kind = ?, trailing_branch = ?, trailing_files = ? WHERE id = ?').run(
            change.after.surface,
            change.after.git_branch,
            change.after.kind,
            change.after.trailing_branch,
            change.after.trailing_files,
            change.sessionId,
        );
        return {};
    },
    async afterApply({ db, adapters, plan }) {
        // has_external_content flips need the actual per-turn values, not just a
        // count - re-derive per changed session inside its own pass rather than
        // carrying every ParsedTurn through the plan object (memory footprint on
        // a large corpus). Still one DB transaction per session's memory rows.
        for (const change of plan.changes) {
            if (change.memoryFlagsChanged === 0 || change.transcriptMissing) {
                continue;
            }
            const session = db
                .prepare('SELECT id, tool, native_id, source_path FROM sessions WHERE id = ?')
                .get(change.sessionId) as SessionSeed;
            const adapter = adapters[session.tool];
            const updateFlag = db.prepare('UPDATE memories SET has_external_content = ? WHERE session_id = ? AND turn_index = ?');
            const writeFlags = db.transaction((turns: ParsedTurn[]) => {
                for (const turn of turns) {
                    updateFlag.run(turn.hasExternalContent ? 1 : 0, change.sessionId, turn.turnIndex);
                }
            });
            // A file that became unreadable between planning and this second
            // pass (a delete/permission race, or a directory path) must
            // not abort the rest of the batch. The sessions-table fields for this
            // session were already written by apply() above; skipping just this
            // session's has_external_content flips leaves them stale rather than
            // manufacturing anything.
            const turns: ParsedTurn[] = [];
            if (!isReadableProviderSource(session.tool, session.source_path)) {
                continue;
            }
            try {
                for await (const turn of adapter.parseTurns(session.source_path, undefined, { closeTrailingOnIdle: true })) {
                    turns.push(turn);
                }
            } catch {
                continue;
            }
            writeFlags(turns);
        }
    },
};

export async function planSessionFieldsBackfill(db: Database, adapters: Record<ToolName, SessionAdapter>): Promise<SessionFieldsPlan> {
    return planBackfill(db, adapters, deriver);
}

// Planning finishes transcript reads before the single write transaction begins.
export async function applySessionFieldsBackfill(db: Database, adapters: Record<ToolName, SessionAdapter>): Promise<SessionFieldsPlan> {
    return applyBackfill(db, adapters, deriver);
}
