import type { Database, Statement } from 'better-sqlite3-multiple-ciphers';
import {
    ASSISTANT_STRUCTURE_MAX_FINALS,
    DURABLE_CAPTURE_FILTER_VERSION,
    type DurableCaptureState,
    SESSION_CHAR_BUDGET,
} from '../config/constants.js';
import { transformAssistantStructure } from '../rendering/assistant-structure.js';
import type { FilterableToolCall, FilteredTurnProjection } from '../rendering/filtered-turn.js';
import { detectShellSyntax, escapeShellSyntax } from '../security/sanitize.js';
import { TURN_SEARCH_INDEX_TABLE } from './turn-search-index.js';

// A reingest that retains a replacement writes the copy and its coverage row
// in one transaction, stamped with the reingest time. A reingested turn whose
// copy is older, or has no coverage row, still holds superseded text; the
// coverage test does not depend on the two timestamps differing. Requires the
// aliases m (memories) and ft (filtered_turns).
export const SUPERSEDED_COPY_SQL = `(m.reingested_at IS NOT NULL AND (ft.captured_at IS NULL OR ft.captured_at < m.reingested_at
    OR NOT EXISTS (SELECT 1 FROM ${TURN_SEARCH_INDEX_TABLE} tsi WHERE tsi.memory_id = m.id)))`;

// A memory's stored evidence is current only as a retained copy written under
// the current filter that no later reingest superseded. Row presence alone
// proves neither; matching per-turn coverage must also authenticate any
// stored memory digest. Requires the aliases m (memories) and ft (filtered_turns,
// left-joined).
export const NOT_CURRENT_COPY_SQL = `(ft.memory_id IS NULL OR ft.filter_version <> ${DURABLE_CAPTURE_FILTER_VERSION}
    OR ${SUPERSEDED_COPY_SQL}
    OR NOT EXISTS (SELECT 1 FROM ${TURN_SEARCH_INDEX_TABLE} tsi WHERE tsi.memory_id = m.id
        AND tsi.filter_version = ft.filter_version
        AND length(tsi.source_digest) = 64 AND tsi.source_digest NOT GLOB '*[^a-f0-9]*'
        AND (m.source_digest IS NULL OR m.source_digest = tsi.source_digest)))`;

interface MutableTextEntry {
    kind: 'text';
    value: string;
}

interface ToolEntry {
    kind: 'tool';
    value: FilterableToolCall;
    chars: number;
}

type ProjectionEntry = MutableTextEntry | ToolEntry;

export interface StoredProjection {
    userPrompt: string;
    assistantResponse: string;
    assistantStructure: string | null;
    toolCalls: FilterableToolCall[];
    omittedBeforeChars: number;
    droppedToolRefCount: number;
}

export type DurableCaptureRecordResult = 'retained' | 'not_retained';

export function boundedSanitizedProjection(projection: FilteredTurnProjection): StoredProjection {
    const entries: ProjectionEntry[] = [];
    let retainedChars = 0;
    let omittedBeforeChars = 0;
    let droppedToolRefCount = 0;

    const enforceBound = (): void => {
        while (retainedChars > SESSION_CHAR_BUDGET && entries.length > 0) {
            const oldest = entries[0];
            if (!oldest) {
                break;
            }
            const overflow = retainedChars - SESSION_CHAR_BUDGET;
            if (oldest.kind === 'tool') {
                entries.shift();
                retainedChars -= oldest.chars;
                omittedBeforeChars += oldest.chars;
                droppedToolRefCount++;
                continue;
            }
            let dropped = Math.min(overflow, oldest.value.length);
            oldest.value = oldest.value.slice(dropped);
            // Truncating an escaped value between its backslash and active
            // token could make the retained suffix executable again. Move
            // past that boundary token rather than storing an unsafe suffix.
            while (oldest.value.length > 0 && detectShellSyntax(oldest.value)) {
                oldest.value = oldest.value.slice(1);
                dropped++;
            }
            retainedChars -= dropped;
            omittedBeforeChars += dropped;
            if (oldest.value.length === 0) {
                entries.shift();
            }
        }
    };

    const appendText = (value: string): MutableTextEntry => {
        const entry: MutableTextEntry = { kind: 'text', value: escapeShellSyntax(value) };
        entries.push(entry);
        retainedChars += entry.value.length;
        enforceBound();
        return entry;
    };

    const userPrompt = appendText(projection.userPrompt);
    const sanitizedAssistantLength = escapeShellSyntax(projection.assistantResponse).length;
    const assistantResponse = appendText(projection.assistantResponse);
    const structure = transformAssistantStructure(projection.assistantResponse, projection.assistantStructure, escapeShellSyntax);
    for (const call of projection.toolCalls) {
        const value = {
            name: escapeShellSyntax(call.name),
            filePaths: call.filePaths.map(escapeShellSyntax),
        };
        const chars = value.name.length + value.filePaths.reduce((sum, filePath) => sum + filePath.length, 0);
        entries.push({ kind: 'tool', value, chars });
        retainedChars += chars;
        enforceBound();
    }

    const retainedAssistant = entries.includes(assistantResponse) ? assistantResponse.value : '';
    const droppedAssistantChars = sanitizedAssistantLength - retainedAssistant.length;
    const retainedFinals = structure?.finals
        .filter(([start]) => start >= droppedAssistantChars)
        .map(([start, end]): [number, number] => [start - droppedAssistantChars, end - droppedAssistantChars])
        .slice(-ASSISTANT_STRUCTURE_MAX_FINALS);
    return {
        userPrompt: entries.includes(userPrompt) ? userPrompt.value : '',
        assistantResponse: retainedAssistant,
        assistantStructure:
            structure === undefined || retainedFinals === undefined
                ? null
                : JSON.stringify({
                      ...structure,
                      finals: retainedFinals,
                      omitted: structure.omitted + structure.finals.length - retainedFinals.length,
                  }),
        toolCalls: entries.flatMap((entry) => (entry.kind === 'tool' ? [entry.value] : [])),
        omittedBeforeChars,
        droppedToolRefCount,
    };
}

export class DurableCaptureStore {
    private readonly insertFilteredTurn: Statement;
    private readonly sessionCaptureState: Statement;
    private readonly upsertStatus: Statement;
    private readonly statusForSession: Statement;

    constructor(db: Database) {
        this.insertFilteredTurn = db.prepare(
            `INSERT INTO filtered_turns
             (memory_id, included, user_prompt, assistant_response, tool_calls, omitted_tool_call_count,
              dropped_tool_ref_count, omitted_before_chars, filter_version, captured_at, assistant_structure)
             VALUES (@memory_id, @included, @user_prompt, @assistant_response, @tool_calls, @omitted_tool_call_count,
                     @dropped_tool_ref_count, @omitted_before_chars, @filter_version, @captured_at, @assistant_structure)`,
        );
        // A parse failure in ordinary ingestion keeps coverage incomplete.
        this.sessionCaptureState = db.prepare(
            `SELECT CASE
                WHEN EXISTS (SELECT 1 FROM durable_capture_status WHERE session_id = ? AND state = 'parse_error') THEN 'parse_error'
                WHEN EXISTS (
                    SELECT 1 FROM memories m
                    LEFT JOIN filtered_turns ft ON ft.memory_id = m.id
                    WHERE m.session_id = ? AND ${NOT_CURRENT_COPY_SQL}
                ) THEN 'disabled_gap'
                WHEN EXISTS (
                    SELECT 1 FROM filtered_turns ft
                    JOIN memories m ON m.id = ft.memory_id
                    WHERE m.session_id = ? AND (ft.omitted_before_chars > 0 OR ft.dropped_tool_ref_count > 0)
                ) THEN 'complete_truncated'
                ELSE 'complete'
             END AS state`,
        );
        this.upsertStatus = db.prepare(
            `INSERT INTO durable_capture_status (session_id, state, filter_version, updated_at)
             VALUES (?, ?, ?, ?)
             ON CONFLICT (session_id) DO UPDATE SET
               state = excluded.state,
               filter_version = excluded.filter_version,
               updated_at = excluded.updated_at`,
        );
        this.statusForSession = db.prepare('SELECT state FROM durable_capture_status WHERE session_id = ?');
    }

    record(
        memoryId: number | bigint,
        sessionId: number,
        projection: FilteredTurnProjection,
        capturedAt: string,
    ): DurableCaptureRecordResult {
        // Sessions whose copies the retired per-copy size limit evicted keep
        // that terminal state; nothing evicts an individual copy any more.
        const status = this.statusForSession.get(sessionId) as { state: DurableCaptureState } | undefined;
        if (status?.state === 'evicted') {
            return 'not_retained';
        }
        const stored = projection.included
            ? boundedSanitizedProjection(projection)
            : {
                  userPrompt: '',
                  assistantResponse: '',
                  assistantStructure: null,
                  toolCalls: [],
                  omittedBeforeChars: 0,
                  droppedToolRefCount: 0,
              };
        if (projection.included && projection.assistantStructure !== undefined && stored.assistantStructure === null) {
            console.warn(
                `[elepha] assistant phase mapping unavailable after sanitizing session ${sessionId}, memory ${memoryId}; response unclassified`,
            );
        }
        this.insertFilteredTurn.run({
            memory_id: memoryId,
            included: projection.included ? 1 : 0,
            user_prompt: stored.userPrompt,
            assistant_response: stored.assistantResponse,
            assistant_structure: stored.assistantStructure,
            tool_calls: JSON.stringify(stored.toolCalls),
            omitted_tool_call_count: projection.included ? projection.omittedToolCallCount : 0,
            dropped_tool_ref_count: stored.droppedToolRefCount,
            omitted_before_chars: stored.omittedBeforeChars,
            filter_version: projection.filterVersion,
            captured_at: capturedAt,
        });
        const row = this.sessionCaptureState.get(sessionId, sessionId, sessionId) as { state: DurableCaptureState };
        this.upsertStatus.run(sessionId, row.state, projection.filterVersion, capturedAt);
        return 'retained';
    }

    setStatus(sessionId: number, state: DurableCaptureState, updatedAt: string): void {
        this.upsertStatus.run(sessionId, state, DURABLE_CAPTURE_FILTER_VERSION, updatedAt);
    }

    // The state the stored rows and any ingestion parse failure support now,
    // without recording it.
    computedState(sessionId: number): DurableCaptureState {
        return (this.sessionCaptureState.get(sessionId, sessionId, sessionId) as { state: DurableCaptureState }).state;
    }

    refreshStatus(sessionId: number, updatedAt: string): DurableCaptureState {
        const state = this.computedState(sessionId);
        this.setStatus(sessionId, state, updatedAt);
        return state;
    }
}
