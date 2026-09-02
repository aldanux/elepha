// Destructive re-segmentation and manual boundary corrections.
//
// Planning is read-only and reparses source JSONL so Codex resume markers and
// exact turn-close timestamps participate. Apply consumes the exact previewed
// plan in one SQLite transaction, invalidates affected rollups, and verifies
// the retained-turn partition afterwards. A missing/mismatched transcript is
// reported and skipped; there is no silent branch/files-only fallback.

import { existsSync } from 'node:fs';
import type { Database } from 'better-sqlite3';
import { claudeCodeSurface, codexSurface, toSessionRowKind } from '../adapters/discriminators.js';
import { TRAILING_FILES_CAP } from '../config/constants.js';
import { dedupePaths, isWithinProviderStore } from '../config/paths.js';
import { RAW_TURN_SEPARATOR, renderRawTurn } from '../rendering/raw-turn-renderer.js';
import type { ParsedTurn, SessionAdapter, SessionRowKind, SessionRowSurface, ToolName } from '../types/index.js';
import { errorMessage } from '../util/error.js';
import { firstPromptSearch } from './first-prompt-search.js';
import { assessSegmentBoundary, evaluateSegmentBoundary, type SegmentBoundaryEvidence, type SegmentBoundaryInput } from './segmentation.js';
import { titleForSegment } from './session-title.js';
import { newUlid } from './ulid.js';

const TEMP_SEGMENT_OFFSET = 1_000_000;

export interface StoredSession {
    id: number;
    tool: ToolName;
    native_id: string;
    segment_index: number;
    project_id: number;
    source_path: string;
    cursor: string | null;
    title: string | null;
    first_prompt_search: string | null;
    started_at: string;
    last_ingested_at: string;
    surface: SessionRowSurface | null;
    git_branch: string | null;
    kind: SessionRowKind | null;
    last_turn_at: string | null;
    trailing_branch: string | null;
    trailing_files: string;
    git_commit_count: number | null;
}

interface StoredMemory {
    id: number;
    session_id: number;
    project_id: number;
    turn_index: number;
    turn_started_at: string;
    created_at: string;
    files_touched: string;
}

export interface PlannedCut {
    atTurnIndex: number;
    gapHours: number;
    evidence: SegmentBoundaryEvidence[];
    fileOverlap: number | null;
}

export interface PlannedSegment {
    segmentIndex: number;
    existingSessionId: number | null;
    memoryIds: number[];
    turnIndexes: number[];
    projectId: number;
    startedAt: string;
    lastIngestedAt: string;
    lastTurnAt: string;
    trailingBranch: string | null;
    trailingFiles: string[];
    gitBranch: string | null;
    surface: SessionRowSurface | null;
    kind: SessionRowKind | null;
    cursor: string | null;
    title: string;
    firstPromptSearch: string;
    renderedChars: number;
    renderedTurns: number;
}

export interface ResegmentationGroupPlan {
    tool: ToolName;
    nativeId: string;
    sourcePath: string;
    existingSessionIds: number[];
    existingSegmentCount: number;
    retainedTurnCount: number;
    resultingSegments: PlannedSegment[];
    cuts: PlannedCut[];
    requiresWrite: boolean;
    rollupsInvalidated: number;
    status: 'ready' | 'skipped';
    issue?: string;
}

export interface ResegmentationPlan {
    groups: ResegmentationGroupPlan[];
    sessionsScanned: number;
    nativeSessionsScanned: number;
    retainedTurnsScanned: number;
    readyGroups: number;
    affectedGroups: number;
    skippedGroups: number;
    resultingSessionRows: number;
}

export interface SegmentationVerification {
    ok: boolean;
    errors: string[];
}

export interface ManualSplitPlan {
    direction: 'split';
    source: StoredSession;
    atTurnIndex: number;
    left: PlannedSegment;
    right: PlannedSegment;
    laterSessionIds: number[];
    rollupsInvalidated: number;
}

export interface ManualMergePlan {
    direction: 'merge';
    left: StoredSession;
    right: StoredSession;
    merged: PlannedSegment;
    laterSessionIds: number[];
    rollupsInvalidated: number;
}

function parseFiles(raw: string): string[] {
    try {
        const value = JSON.parse(raw) as unknown;
        return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
    } catch {
        return [];
    }
}

function normalizedSurface(tool: ToolName, raw: string | undefined): SessionRowSurface | null {
    return tool === 'claude-code' ? claudeCodeSurface(raw) : codexSurface(raw);
}

function gapHours(previousEndedAt: string, nextStartedAt: string): number {
    const previous = Date.parse(previousEndedAt);
    const next = Date.parse(nextStartedAt);
    if (!Number.isFinite(previous) || !Number.isFinite(next)) {
        return 0;
    }
    return Math.max(0, next - previous) / (60 * 60 * 1000);
}

async function parseSource(adapter: SessionAdapter, sourcePath: string): Promise<Map<number, ParsedTurn>> {
    const turns = new Map<number, ParsedTurn>();
    for await (const turn of adapter.parseTurns(sourcePath, undefined, { closeTrailingOnIdle: true })) {
        turns.set(turn.turnIndex, turn);
    }
    return turns;
}

function sessionRows(db: Database): StoredSession[] {
    return db.prepare('SELECT * FROM sessions ORDER BY tool, native_id, segment_index').all() as StoredSession[];
}

function memoriesForSessions(db: Database, ids: number[]): StoredMemory[] {
    if (ids.length === 0) {
        return [];
    }
    return db
        .prepare(
            `SELECT id, session_id, project_id, turn_index, turn_started_at, created_at, files_touched FROM memories WHERE session_id IN (${ids.map(() => '?').join(',')}) ORDER BY turn_index`,
        )
        .all(...ids) as StoredMemory[];
}

function countInvalidatedRollups(db: Database, sessionIds: number[]): number {
    if (sessionIds.length === 0) {
        return 0;
    }
    const placeholders = sessionIds.map(() => '?').join(',');
    return (
        db
            .prepare(
                `SELECT COUNT(*) AS count FROM session_rollups WHERE session_id IN (${placeholders}) OR parent_session_id IN (${placeholders})`,
            )
            .get(...sessionIds, ...sessionIds) as { count: number }
    ).count;
}

function newSegment(
    index: number,
    existingSessionId: number | null,
    memory: StoredMemory,
    turn: ParsedTurn,
    kind: SessionRowKind | null,
): PlannedSegment {
    return {
        segmentIndex: index,
        existingSessionId,
        memoryIds: [],
        turnIndexes: [],
        projectId: memory.project_id,
        startedAt: turn.startedAt,
        lastIngestedAt: memory.created_at,
        lastTurnAt: turn.endedAt,
        trailingBranch: null,
        trailingFiles: [],
        gitBranch: turn.gitBranch ?? null,
        surface: normalizedSurface(turn.tool, turn.surface),
        kind,
        cursor: null,
        title: '',
        firstPromptSearch: '',
        renderedChars: 0,
        renderedTurns: 0,
    };
}

function appendTurn(segment: PlannedSegment, memory: StoredMemory, turn: ParsedTurn): void {
    segment.memoryIds.push(memory.id);
    segment.turnIndexes.push(memory.turn_index);
    segment.lastIngestedAt = memory.created_at > segment.lastIngestedAt ? memory.created_at : segment.lastIngestedAt;
    segment.lastTurnAt = turn.endedAt;
    segment.trailingBranch = turn.gitBranch ?? segment.trailingBranch;
    const turnFiles = turn.toolCalls.flatMap((call) => call.filePaths);
    segment.trailingFiles = dedupePaths([...turnFiles, ...segment.trailingFiles]).slice(0, TRAILING_FILES_CAP);
    const rendered = renderRawTurn(turn, segment.renderedTurns + 1);
    if (rendered !== null) {
        segment.renderedChars += (segment.renderedChars === 0 ? 1 : RAW_TURN_SEPARATOR.length) + rendered.length;
        segment.renderedTurns++;
    }
}

function titleForPlannedSegment(segment: PlannedSegment, parsed: Map<number, ParsedTurn>): string {
    const turns = segment.turnIndexes.map((index) => {
        const turn = parsed.get(index);
        if (!turn) {
            throw new Error(`missing parsed turn ${index}`);
        }
        return turn;
    });
    return titleForSegment(turns, segment.segmentIndex === 0);
}

function firstPromptSearchForPlannedSegment(segment: PlannedSegment, parsed: Map<number, ParsedTurn>): string {
    const firstTurnIndex = segment.turnIndexes[0];
    const firstTurn = parsed.get(firstTurnIndex);
    if (!firstTurn) {
        throw new Error(`missing parsed turn ${firstTurnIndex}`);
    }
    return firstPromptSearch(firstTurn.userMessage);
}

function buildSegments(
    memories: StoredMemory[],
    parsed: Map<number, ParsedTurn>,
    existingByIndex: Map<number, StoredSession>,
    kind: SessionRowKind | null,
    latestCursor: string | null,
): { segments: PlannedSegment[]; cuts: PlannedCut[] } {
    const segments: PlannedSegment[] = [];
    const cuts: PlannedCut[] = [];
    let active: PlannedSegment | undefined;

    for (const memory of memories) {
        const turn = parsed.get(memory.turn_index);
        if (!turn) {
            throw new Error(`retained turn ${memory.turn_index} was not produced by the current adapter`);
        }

        if (active) {
            const input: SegmentBoundaryInput = {
                gapHours: gapHours(active.lastTurnAt, turn.startedAt),
                trailingBranch: active.trailingBranch,
                resumingBranch: turn.gitBranch ?? null,
                trailingFiles: active.trailingFiles,
                resumingFiles: turn.toolCalls.flatMap((call) => call.filePaths),
                resumeMarkerBefore: turn.resumeMarkerBefore,
            };
            // Keep the explicit evaluator call: this is the same public pure
            // boundary function live ingestion uses. assessSegmentBoundary is
            // only the explanation for the preview line.
            if (evaluateSegmentBoundary(input)) {
                const assessment = assessSegmentBoundary(input);
                cuts.push({
                    atTurnIndex: memory.turn_index,
                    gapHours: input.gapHours,
                    evidence: assessment.evidence,
                    fileOverlap: assessment.fileOverlap,
                });
                const nextIndex = segments.length;
                active = newSegment(nextIndex, existingByIndex.get(nextIndex)?.id ?? null, memory, turn, kind);
                segments.push(active);
            }
        } else {
            active = newSegment(0, existingByIndex.get(0)?.id ?? null, memory, turn, kind);
            segments.push(active);
        }
        appendTurn(active, memory, turn);
    }

    if (segments.length > 0) {
        segments[segments.length - 1].cursor = latestCursor;
    }
    for (const segment of segments) {
        segment.title = titleForPlannedSegment(segment, parsed);
        segment.firstPromptSearch = firstPromptSearchForPlannedSegment(segment, parsed);
    }
    return { segments, cuts };
}

function groupRequiresWrite(rows: StoredSession[], memories: StoredMemory[], segments: PlannedSegment[]): boolean {
    if (rows.length !== segments.length) {
        return true;
    }
    const rowByIndex = new Map(rows.map((row) => [row.segment_index, row]));
    const memorySessionById = new Map(memories.map((memory) => [memory.id, memory.session_id]));
    for (const segment of segments) {
        const row = rowByIndex.get(segment.segmentIndex);
        if (
            !row ||
            row.project_id !== segment.projectId ||
            row.source_path !== rows[rows.length - 1].source_path ||
            row.cursor !== segment.cursor ||
            row.title !== segment.title ||
            row.first_prompt_search !== segment.firstPromptSearch ||
            row.started_at !== segment.startedAt ||
            row.last_ingested_at !== segment.lastIngestedAt ||
            row.surface !== segment.surface ||
            row.git_branch !== segment.gitBranch ||
            row.kind !== segment.kind ||
            row.last_turn_at !== segment.lastTurnAt ||
            row.trailing_branch !== segment.trailingBranch ||
            JSON.stringify(parseFiles(row.trailing_files)) !== JSON.stringify(segment.trailingFiles) ||
            segment.memoryIds.some((memoryId) => memorySessionById.get(memoryId) !== row.id)
        ) {
            return true;
        }
    }
    return false;
}

function groupRows(rows: StoredSession[]): StoredSession[][] {
    const groups = new Map<string, StoredSession[]>();
    for (const row of rows) {
        const key = `${row.tool}\0${row.native_id}`;
        const group = groups.get(key);
        if (group) {
            group.push(row);
        } else {
            groups.set(key, [row]);
        }
    }
    return [...groups.values()];
}

// Read-only preview. Re-reads JSONL so resumeMarkerBefore is not discarded.
export async function planResegmentation(db: Database, adapters: Record<ToolName, SessionAdapter>): Promise<ResegmentationPlan> {
    const allSessions = sessionRows(db);
    const groups: ResegmentationGroupPlan[] = [];
    let retainedTurnsScanned = 0;

    for (const rows of groupRows(allSessions)) {
        const latest = rows[rows.length - 1];
        const ids = rows.map((row) => row.id);
        const memories = memoriesForSessions(db, ids);
        retainedTurnsScanned += memories.length;
        const base: Omit<ResegmentationGroupPlan, 'status' | 'resultingSegments' | 'cuts'> = {
            tool: latest.tool,
            nativeId: latest.native_id,
            sourcePath: latest.source_path,
            existingSessionIds: ids,
            existingSegmentCount: rows.length,
            retainedTurnCount: memories.length,
            requiresWrite: false,
            rollupsInvalidated: countInvalidatedRollups(db, ids),
        };

        if (memories.length === 0) {
            groups.push({ ...base, status: 'skipped', issue: 'no retained turns', resultingSegments: [], cuts: [] });
            continue;
        }
        if (!isWithinProviderStore(latest.tool, latest.source_path)) {
            groups.push({
                ...base,
                status: 'skipped',
                issue: 'source transcript is outside the provider store',
                resultingSegments: [],
                cuts: [],
            });
            continue;
        }
        if (!existsSync(latest.source_path)) {
            groups.push({ ...base, status: 'skipped', issue: 'source transcript is missing', resultingSegments: [], cuts: [] });
            continue;
        }

        try {
            const classification = await adapters[latest.tool].classifySession(latest.source_path);
            const parsed = await parseSource(adapters[latest.tool], latest.source_path);
            const existingByIndex = new Map(rows.map((row) => [row.segment_index, row]));
            const { segments, cuts } = buildSegments(
                memories,
                parsed,
                existingByIndex,
                toSessionRowKind(classification.kind),
                latest.cursor,
            );
            const requiresWrite = groupRequiresWrite(rows, memories, segments);
            groups.push({
                ...base,
                status: 'ready',
                requiresWrite,
                rollupsInvalidated: requiresWrite ? base.rollupsInvalidated : 0,
                resultingSegments: segments,
                cuts,
            });
        } catch (error) {
            groups.push({
                ...base,
                status: 'skipped',
                issue: errorMessage(error),
                resultingSegments: [],
                cuts: [],
            });
        }
    }

    const ready = groups.filter((group) => group.status === 'ready');
    return {
        groups,
        sessionsScanned: allSessions.length,
        nativeSessionsScanned: groups.length,
        retainedTurnsScanned,
        readyGroups: ready.length,
        affectedGroups: ready.filter((group) => group.requiresWrite).length,
        skippedGroups: groups.length - ready.length,
        resultingSessionRows: ready.reduce((sum, group) => sum + group.resultingSegments.length, 0),
    };
}

function assertPlanStillMatches(db: Database, group: ResegmentationGroupPlan): void {
    const currentRows = db
        .prepare('SELECT id FROM sessions WHERE tool = ? AND native_id = ? ORDER BY segment_index')
        .all(group.tool, group.nativeId) as Array<{ id: number }>;
    if (currentRows.map((row) => row.id).join(',') !== group.existingSessionIds.join(',')) {
        throw new Error(`session rows changed after preview for ${group.tool}:${group.nativeId}`);
    }
    const currentMemories = memoriesForSessions(db, group.existingSessionIds);
    const plannedMemoryIds = group.resultingSegments.flatMap((segment) => segment.memoryIds).sort((a, b) => a - b);
    const currentMemoryIds = currentMemories.map((memory) => memory.id).sort((a, b) => a - b);
    if (currentMemoryIds.join(',') !== plannedMemoryIds.join(',')) {
        throw new Error(`retained turns changed after preview for ${group.tool}:${group.nativeId}`);
    }
}

function deleteAffectedRollups(db: Database, sessionIds: number[]): void {
    const placeholders = sessionIds.map(() => '?').join(',');
    db.prepare(`DELETE FROM session_rollups WHERE session_id IN (${placeholders}) OR parent_session_id IN (${placeholders})`).run(
        ...sessionIds,
        ...sessionIds,
    );
}

function ensureCorrectionsTable(db: Database): void {
    // Created only inside an applied correction's transaction. A dry-run must
    // not mutate schema just because this is the first segment command run.
    db.exec(`
      CREATE TABLE IF NOT EXISTS segment_corrections (
        id                INTEGER PRIMARY KEY,
        ulid              TEXT NOT NULL UNIQUE,
        tool              TEXT NOT NULL CHECK (tool IN ('claude-code','codex')),
        native_id         TEXT NOT NULL,
        direction         TEXT NOT NULL CHECK (direction IN ('split','merge')),
        first_session_id  INTEGER NOT NULL,
        second_session_id INTEGER,
        turn_index        INTEGER,
        created_at        TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_segment_corrections_native
        ON segment_corrections(tool, native_id, created_at);
    `);
}

function updateSessionFromSegment(db: Database, sessionId: number, sourcePath: string, segment: PlannedSegment): void {
    db.prepare(
        `UPDATE sessions SET segment_index = ?, project_id = ?, source_path = ?, cursor = ?, title = ?, first_prompt_search = ?, started_at = ?, last_ingested_at = ?,
         surface = ?, git_branch = ?, kind = ?, last_turn_at = ?, trailing_branch = ?, trailing_files = ?, rendered_chars = ?, rendered_turns = ? WHERE id = ?`,
    ).run(
        segment.segmentIndex,
        segment.projectId,
        sourcePath,
        segment.cursor,
        segment.title,
        segment.firstPromptSearch,
        segment.startedAt,
        segment.lastIngestedAt,
        segment.surface,
        segment.gitBranch,
        segment.kind,
        segment.lastTurnAt,
        segment.trailingBranch,
        JSON.stringify(segment.trailingFiles),
        segment.renderedChars,
        segment.renderedTurns,
        sessionId,
    );
}

function insertSessionFromSegment(db: Database, tool: ToolName, nativeId: string, sourcePath: string, segment: PlannedSegment): number {
    const info = db
        .prepare(
            `INSERT INTO sessions
             (tool, native_id, segment_index, project_id, source_path, cursor, started_at, last_ingested_at,
              title, first_prompt_search, surface, git_branch, kind, last_turn_at, trailing_branch, trailing_files, rendered_chars, rendered_turns, git_commit_count)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
            tool,
            nativeId,
            segment.segmentIndex,
            segment.projectId,
            sourcePath,
            segment.cursor,
            segment.startedAt,
            segment.lastIngestedAt,
            segment.title,
            segment.firstPromptSearch,
            segment.surface,
            segment.gitBranch,
            segment.kind,
            segment.lastTurnAt,
            segment.trailingBranch,
            JSON.stringify(segment.trailingFiles),
            segment.renderedChars,
            segment.renderedTurns,
            null,
        );
    return Number(info.lastInsertRowid);
}

// Applies exactly the previewed ready groups in one transaction.
export function applyResegmentation(db: Database, plan: ResegmentationPlan): ResegmentationPlan {
    const ready = plan.groups.filter((group) => group.status === 'ready' && group.requiresWrite);
    const apply = db.transaction(() => {
        for (const group of ready) {
            assertPlanStillMatches(db, group);
            deleteAffectedRollups(db, group.existingSessionIds);
            db.prepare(
                `UPDATE sessions SET segment_index = segment_index + ? WHERE id IN (${group.existingSessionIds.map(() => '?').join(',')})`,
            ).run(TEMP_SEGMENT_OFFSET, ...group.existingSessionIds);

            const used = new Set<number>();
            for (const segment of group.resultingSegments) {
                const sessionId =
                    segment.existingSessionId === null
                        ? insertSessionFromSegment(db, group.tool, group.nativeId, group.sourcePath, segment)
                        : segment.existingSessionId;
                used.add(sessionId);
                updateSessionFromSegment(db, sessionId, group.sourcePath, segment);
                // Re-segmentation is historical reconstruction: it cannot
                // truthfully recover the commit count at each newly inferred
                // opening, including a reused left-hand row.
                db.prepare('UPDATE sessions SET git_commit_count = NULL WHERE id = ?').run(sessionId);
                const updateMemory = db.prepare('UPDATE memories SET session_id = ? WHERE id = ?');
                for (const memoryId of segment.memoryIds) {
                    updateMemory.run(sessionId, memoryId);
                }
            }

            const removed = group.existingSessionIds.filter((id) => !used.has(id));
            if (removed.length > 0) {
                // Rollups for removed rows were already deleted by deleteAffectedRollups, so no reparenting is needed.
                db.prepare(`DELETE FROM sessions WHERE id IN (${removed.map(() => '?').join(',')})`).run(...removed);
            }
        }
    });
    apply();
    return plan;
}

export function verifyResegmentation(db: Database, plan: ResegmentationPlan): SegmentationVerification {
    const errors: string[] = [];
    for (const group of plan.groups) {
        if (group.status !== 'ready' || !group.requiresWrite) {
            continue;
        }
        const rows = db
            .prepare(
                'SELECT id, segment_index, title, first_prompt_search, last_turn_at, trailing_branch, trailing_files, rendered_chars, rendered_turns FROM sessions WHERE tool = ? AND native_id = ? ORDER BY segment_index',
            )
            .all(group.tool, group.nativeId) as Array<{
            id: number;
            segment_index: number;
            title: string | null;
            first_prompt_search: string | null;
            last_turn_at: string | null;
            trailing_branch: string | null;
            trailing_files: string;
            rendered_chars: number | null;
            rendered_turns: number | null;
        }>;
        if (rows.length !== group.resultingSegments.length) {
            errors.push(`${group.tool}:${group.nativeId} has ${rows.length} rows, expected ${group.resultingSegments.length}`);
            continue;
        }
        for (const segment of group.resultingSegments) {
            const row = rows[segment.segmentIndex];
            if (!row || row.segment_index !== segment.segmentIndex) {
                errors.push(`${group.tool}:${group.nativeId} is missing segment ${segment.segmentIndex}`);
                continue;
            }
            const actualTurns = db
                .prepare('SELECT turn_index FROM memories WHERE session_id = ? ORDER BY turn_index')
                .all(row.id) as Array<{
                turn_index: number;
            }>;
            if (actualTurns.map((turn) => turn.turn_index).join(',') !== segment.turnIndexes.join(',')) {
                errors.push(`${group.tool}:${group.nativeId}:${segment.segmentIndex} retained-turn partition differs`);
            }
            if (row.title !== segment.title) {
                errors.push(`${group.tool}:${group.nativeId}:${segment.segmentIndex} title differs`);
            }
            if (row.first_prompt_search !== segment.firstPromptSearch) {
                errors.push(`${group.tool}:${group.nativeId}:${segment.segmentIndex} first_prompt_search differs`);
            }
            if (
                row.last_turn_at !== segment.lastTurnAt ||
                row.trailing_branch !== segment.trailingBranch ||
                JSON.stringify(parseFiles(row.trailing_files)) !== JSON.stringify(segment.trailingFiles)
            ) {
                errors.push(`${group.tool}:${group.nativeId}:${segment.segmentIndex} trailing state differs`);
            }
            if (row.rendered_chars !== segment.renderedChars) {
                errors.push(`${group.tool}:${group.nativeId}:${segment.segmentIndex} rendered_chars differs`);
            }
            if (row.rendered_turns !== segment.renderedTurns) {
                errors.push(`${group.tool}:${group.nativeId}:${segment.segmentIndex} rendered_turns differs`);
            }
        }
        const staleRollups = db
            .prepare(
                `SELECT COUNT(*) AS count FROM session_rollups r JOIN sessions s ON s.id = r.session_id WHERE s.tool = ? AND s.native_id = ?`,
            )
            .get(group.tool, group.nativeId) as { count: number };
        if (staleRollups.count > 0) {
            errors.push(`${group.tool}:${group.nativeId} still has ${staleRollups.count} rollup(s)`);
        }
    }
    const violations = db.pragma('foreign_key_check') as unknown[];
    if (violations.length > 0) {
        errors.push(`foreign_key_check returned ${violations.length} violation(s)`);
    }
    return { ok: errors.length === 0, errors };
}

async function parsedForManual(
    db: Database,
    session: StoredSession,
    adapter: SessionAdapter,
): Promise<{ memories: StoredMemory[]; parsed: Map<number, ParsedTurn>; kind: SessionRowKind | null }> {
    if (!isWithinProviderStore(session.tool, session.source_path)) {
        throw new Error(`source transcript is outside the provider store: ${session.source_path}`);
    }
    if (!existsSync(session.source_path)) {
        throw new Error(`source transcript is missing: ${session.source_path}`);
    }
    const memories = memoriesForSessions(db, [session.id]);
    if (memories.length === 0) {
        throw new Error(`session ${session.id} has no retained turns`);
    }
    const classification = await adapter.classifySession(session.source_path);
    const parsed = await parseSource(adapter, session.source_path);
    for (const memory of memories) {
        if (!parsed.has(memory.turn_index)) {
            throw new Error(`retained turn ${memory.turn_index} was not produced by the current adapter`);
        }
    }
    return { memories, parsed, kind: toSessionRowKind(classification.kind) };
}

function segmentFromRange(
    index: number,
    existingSessionId: number | null,
    memories: StoredMemory[],
    parsed: Map<number, ParsedTurn>,
    kind: SessionRowKind | null,
    cursor: string | null,
): PlannedSegment {
    const first = memories[0];
    const firstTurn = parsed.get(first.turn_index);
    if (!firstTurn) {
        throw new Error(`missing parsed turn ${first.turn_index}`);
    }
    const segment = newSegment(index, existingSessionId, first, firstTurn, kind);
    for (const memory of memories) {
        const turn = parsed.get(memory.turn_index);
        if (!turn) {
            throw new Error(`missing parsed turn ${memory.turn_index}`);
        }
        appendTurn(segment, memory, turn);
    }
    segment.cursor = cursor;
    segment.title = titleForPlannedSegment(segment, parsed);
    segment.firstPromptSearch = firstPromptSearchForPlannedSegment(segment, parsed);
    return segment;
}

function sessionById(db: Database, id: number): StoredSession {
    const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as StoredSession | undefined;
    if (!row) {
        throw new Error(`session ${id} does not exist`);
    }
    return row;
}

export async function planManualSplit(
    db: Database,
    adapters: Record<ToolName, SessionAdapter>,
    sessionId: number,
    atTurnIndex: number,
): Promise<ManualSplitPlan> {
    const source = sessionById(db, sessionId);
    const { memories, parsed, kind } = await parsedForManual(db, source, adapters[source.tool]);
    const splitAt = memories.findIndex((memory) => memory.turn_index === atTurnIndex);
    if (splitAt <= 0) {
        throw new Error(`--at must name a retained turn after the first turn in session ${sessionId}`);
    }
    const laterRows = db
        .prepare('SELECT id FROM sessions WHERE tool = ? AND native_id = ? AND segment_index > ? ORDER BY segment_index')
        .all(source.tool, source.native_id, source.segment_index) as Array<{ id: number }>;
    return {
        direction: 'split',
        source,
        atTurnIndex,
        left: segmentFromRange(source.segment_index, source.id, memories.slice(0, splitAt), parsed, kind, null),
        right: segmentFromRange(source.segment_index + 1, null, memories.slice(splitAt), parsed, kind, source.cursor),
        laterSessionIds: laterRows.map((row) => row.id),
        rollupsInvalidated: countInvalidatedRollups(db, [source.id]),
    };
}

export function applyManualSplit(db: Database, plan: ManualSplitPlan): number {
    const apply = db.transaction(() => {
        ensureCorrectionsTable(db);
        const source = sessionById(db, plan.source.id);
        const currentIds = memoriesForSessions(db, [source.id]).map((memory) => memory.id);
        if (currentIds.join(',') !== [...plan.left.memoryIds, ...plan.right.memoryIds].join(',')) {
            throw new Error(`session ${source.id} changed after preview`);
        }
        deleteAffectedRollups(db, [source.id]);
        if (plan.laterSessionIds.length > 0) {
            db.prepare(
                `UPDATE sessions SET segment_index = segment_index + ? WHERE id IN (${plan.laterSessionIds.map(() => '?').join(',')})`,
            ).run(TEMP_SEGMENT_OFFSET, ...plan.laterSessionIds);
            db.prepare(
                `UPDATE sessions SET segment_index = segment_index - ? + 1 WHERE id IN (${plan.laterSessionIds.map(() => '?').join(',')})`,
            ).run(TEMP_SEGMENT_OFFSET, ...plan.laterSessionIds);
        }
        updateSessionFromSegment(db, source.id, source.source_path, plan.left);
        const newSessionId = insertSessionFromSegment(db, source.tool, source.native_id, source.source_path, plan.right);
        const move = db.prepare('UPDATE memories SET session_id = ? WHERE id = ?');
        for (const memoryId of plan.right.memoryIds) {
            move.run(newSessionId, memoryId);
        }
        db.prepare(
            `INSERT INTO segment_corrections (ulid, tool, native_id, direction, first_session_id, second_session_id, turn_index, created_at)
             VALUES (?, ?, ?, 'split', ?, ?, ?, ?)`,
        ).run(newUlid(), source.tool, source.native_id, source.id, newSessionId, plan.atTurnIndex, new Date().toISOString());
        return newSessionId;
    });
    return apply();
}

export async function planManualMerge(
    db: Database,
    adapters: Record<ToolName, SessionAdapter>,
    firstId: number,
    secondId: number,
): Promise<ManualMergePlan> {
    const first = sessionById(db, firstId);
    const second = sessionById(db, secondId);
    if (first.tool !== second.tool || first.native_id !== second.native_id) {
        throw new Error('merge requires two segments from the same native session');
    }
    const [left, right] = first.segment_index < second.segment_index ? [first, second] : [second, first];
    if (right.segment_index !== left.segment_index + 1) {
        throw new Error('merge requires adjacent segment indexes');
    }
    if (!isWithinProviderStore(left.tool, left.source_path)) {
        throw new Error(`source transcript is outside the provider store: ${left.source_path}`);
    }
    if (!existsSync(left.source_path)) {
        throw new Error(`source transcript is missing: ${left.source_path}`);
    }
    const parsed = await parseSource(adapters[left.tool], left.source_path);
    const classification = await adapters[left.tool].classifySession(left.source_path);
    const memories = [...memoriesForSessions(db, [left.id]), ...memoriesForSessions(db, [right.id])].sort(
        (a, b) => a.turn_index - b.turn_index,
    );
    for (const memory of memories) {
        if (!parsed.has(memory.turn_index)) {
            throw new Error(`retained turn ${memory.turn_index} was not produced by the current adapter`);
        }
    }
    const later = db
        .prepare('SELECT id FROM sessions WHERE tool = ? AND native_id = ? AND segment_index > ? ORDER BY segment_index')
        .all(left.tool, left.native_id, right.segment_index) as Array<{ id: number }>;
    return {
        direction: 'merge',
        left,
        right,
        merged: segmentFromRange(
            left.segment_index,
            left.id,
            memories,
            parsed,
            toSessionRowKind(classification.kind),
            right.cursor ?? left.cursor,
        ),
        laterSessionIds: later.map((row) => row.id),
        rollupsInvalidated: countInvalidatedRollups(db, [left.id, right.id]),
    };
}

export function applyManualMerge(db: Database, plan: ManualMergePlan): number {
    const apply = db.transaction(() => {
        ensureCorrectionsTable(db);
        const left = sessionById(db, plan.left.id);
        const right = sessionById(db, plan.right.id);
        const currentIds = [...memoriesForSessions(db, [left.id]), ...memoriesForSessions(db, [right.id])]
            .sort((a, b) => a.turn_index - b.turn_index)
            .map((memory) => memory.id);
        if (currentIds.join(',') !== plan.merged.memoryIds.join(',')) {
            throw new Error(`segments ${left.id}/${right.id} changed after preview`);
        }
        deleteAffectedRollups(db, [left.id, right.id]);
        const move = db.prepare('UPDATE memories SET session_id = ? WHERE id = ?');
        for (const memoryId of plan.merged.memoryIds) {
            move.run(left.id, memoryId);
        }
        updateSessionFromSegment(db, left.id, left.source_path, plan.merged);
        db.prepare('UPDATE session_rollups SET parent_session_id = ? WHERE parent_session_id = ?').run(left.id, right.id);
        db.prepare('DELETE FROM sessions WHERE id = ?').run(right.id);
        if (plan.laterSessionIds.length > 0) {
            db.prepare(
                `UPDATE sessions SET segment_index = segment_index + ? WHERE id IN (${plan.laterSessionIds.map(() => '?').join(',')})`,
            ).run(TEMP_SEGMENT_OFFSET, ...plan.laterSessionIds);
            db.prepare(
                `UPDATE sessions SET segment_index = segment_index - ? - 1 WHERE id IN (${plan.laterSessionIds.map(() => '?').join(',')})`,
            ).run(TEMP_SEGMENT_OFFSET, ...plan.laterSessionIds);
        }
        db.prepare(
            `INSERT INTO segment_corrections (ulid, tool, native_id, direction, first_session_id, second_session_id, turn_index, created_at)
             VALUES (?, ?, ?, 'merge', ?, ?, NULL, ?)`,
        ).run(newUlid(), left.tool, left.native_id, left.id, right.id, new Date().toISOString());
        return left.id;
    });
    return apply();
}
