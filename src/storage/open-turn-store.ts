import type { Database } from 'better-sqlite3-multiple-ciphers';
import type { FilteredTurnProjection } from '../rendering/filtered-turn.js';
import { stripShellSyntax } from '../security/sanitize.js';
import type { OpenTailObservation, SummarizationOutput, ToolName } from '../types/index.js';
import { boundedSanitizedProjection } from './durable-capture-store.js';
import { sourceTurnDigest } from './source-turn-digest.js';
import { sanitizeTurnDecision } from './turn-store.js';

export interface OpenTurnSourceSnapshot {
    dev: string;
    ino: string;
    size: number;
    mtimeMs: number;
    revision: string;
}

export interface OpenTurnRow {
    tool: ToolName;
    native_session_id: string;
    session_id: number;
    project_id: number;
    source_generation: number;
    turn_index: number;
    anchor_cursor: string | null;
    candidate_cursor: string;
    source_path: string;
    source_dev: string;
    source_ino: string;
    source_size: number;
    source_mtime_ms: number;
    source_revision: string;
    source_digest: string;
    failed_at: string;
    observed_at: string;
    staged_at: string | null;
    validation_epoch: number;
    validated_epoch: number;
    receipt_coverage: 'complete' | 'incomplete';
    receipt_failure: string | null;
    decisions: string | null;
    pending_items: string | null;
    summarizer_status: string | null;
    durable_included: number | null;
    durable_user_prompt: string | null;
    durable_assistant_response: string | null;
    durable_assistant_structure: string | null;
    durable_tool_calls: string | null;
    durable_omitted_tool_call_count: number | null;
    durable_dropped_tool_ref_count: number | null;
    durable_omitted_before_chars: number | null;
    durable_filter_version: number | null;
}

export class OpenTurnStore {
    constructor(private readonly db: Database) {}

    find(tool: ToolName, nativeSessionId: string): OpenTurnRow | undefined {
        return this.db.prepare('SELECT * FROM open_turns WHERE tool = ? AND native_session_id = ?').get(tool, nativeSessionId) as
            | OpenTurnRow
            | undefined;
    }

    beginValidation(tool: ToolName, nativeSessionId: string, minimumEpoch: number): number {
        return this.db.transaction(() => {
            this.db
                .prepare(
                    `UPDATE open_turns
                     SET validation_epoch = MAX(validation_epoch + 1, ?)
                     WHERE tool = ? AND native_session_id = ?`,
                )
                .run(minimumEpoch, tool, nativeSessionId);
            return this.find(tool, nativeSessionId)?.validation_epoch ?? minimumEpoch;
        })();
    }

    invalidateChangedSource(tool: ToolName, nativeSessionId: string, sourceGeneration: number, source: OpenTurnSourceSnapshot): boolean {
        return (
            this.db
                .prepare(
                    `DELETE FROM open_turns
                     WHERE tool = ? AND native_session_id = ?
                       AND (source_generation <> ? OR source_dev <> ? OR source_ino <> ? OR source_size <> ? OR source_mtime_ms <> ?)`,
                )
                .run(tool, nativeSessionId, sourceGeneration, source.dev, source.ino, source.size, source.mtimeMs).changes > 0
        );
    }

    observe(
        observation: OpenTailObservation,
        sessionId: number,
        projectId: number,
        sourceGeneration: number,
        source: OpenTurnSourceSnapshot,
        observedAt: string,
        validationEpoch: number,
    ): OpenTurnRow | undefined {
        const turn = observation.receiptCoverage.turn;
        this.db
            .prepare(
                `INSERT INTO open_turns
                 (tool, native_session_id, session_id, project_id, source_generation, turn_index,
                  anchor_cursor, candidate_cursor, source_path, source_dev, source_ino, source_size,
                  source_mtime_ms, source_revision, source_digest, failed_at, observed_at, validation_epoch, validated_epoch,
                  receipt_coverage, receipt_failure)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT(tool, native_session_id) DO UPDATE SET
                   session_id = excluded.session_id,
                   project_id = excluded.project_id,
                   source_generation = excluded.source_generation,
                   turn_index = excluded.turn_index,
                   anchor_cursor = excluded.anchor_cursor,
                   candidate_cursor = excluded.candidate_cursor,
                   source_path = excluded.source_path,
                   source_dev = excluded.source_dev,
                   source_ino = excluded.source_ino,
                   source_size = excluded.source_size,
                   source_mtime_ms = excluded.source_mtime_ms,
                   source_digest = excluded.source_digest,
                   failed_at = excluded.failed_at,
                   observed_at = excluded.observed_at,
                   receipt_coverage = excluded.receipt_coverage,
                   receipt_failure = excluded.receipt_failure,
                   validated_epoch = excluded.validation_epoch,
                   staged_at = CASE WHEN open_turns.source_revision = excluded.source_revision AND open_turns.source_digest = excluded.source_digest THEN open_turns.staged_at END,
                   decisions = CASE WHEN open_turns.source_revision = excluded.source_revision AND open_turns.source_digest = excluded.source_digest THEN open_turns.decisions END,
                   pending_items = CASE WHEN open_turns.source_revision = excluded.source_revision AND open_turns.source_digest = excluded.source_digest THEN open_turns.pending_items END,
                   summarizer_status = CASE WHEN open_turns.source_revision = excluded.source_revision AND open_turns.source_digest = excluded.source_digest THEN open_turns.summarizer_status END,
                   durable_included = CASE WHEN open_turns.source_revision = excluded.source_revision AND open_turns.source_digest = excluded.source_digest THEN open_turns.durable_included END,
                   durable_user_prompt = CASE WHEN open_turns.source_revision = excluded.source_revision AND open_turns.source_digest = excluded.source_digest THEN open_turns.durable_user_prompt END,
                   durable_assistant_response = CASE WHEN open_turns.source_revision = excluded.source_revision AND open_turns.source_digest = excluded.source_digest THEN open_turns.durable_assistant_response END,
                   durable_assistant_structure = CASE WHEN open_turns.source_revision = excluded.source_revision AND open_turns.source_digest = excluded.source_digest THEN open_turns.durable_assistant_structure END,
                   durable_tool_calls = CASE WHEN open_turns.source_revision = excluded.source_revision AND open_turns.source_digest = excluded.source_digest THEN open_turns.durable_tool_calls END,
                   durable_omitted_tool_call_count = CASE WHEN open_turns.source_revision = excluded.source_revision AND open_turns.source_digest = excluded.source_digest THEN open_turns.durable_omitted_tool_call_count END,
                   durable_dropped_tool_ref_count = CASE WHEN open_turns.source_revision = excluded.source_revision AND open_turns.source_digest = excluded.source_digest THEN open_turns.durable_dropped_tool_ref_count END,
                   durable_omitted_before_chars = CASE WHEN open_turns.source_revision = excluded.source_revision AND open_turns.source_digest = excluded.source_digest THEN open_turns.durable_omitted_before_chars END,
                   durable_filter_version = CASE WHEN open_turns.source_revision = excluded.source_revision AND open_turns.source_digest = excluded.source_digest THEN open_turns.durable_filter_version END,
                   source_revision = excluded.source_revision
                 WHERE open_turns.validation_epoch = excluded.validation_epoch`,
            )
            .run(
                turn.tool,
                turn.sessionId,
                sessionId,
                projectId,
                sourceGeneration,
                turn.turnIndex,
                observation.anchorCursor ?? null,
                observation.candidateCursor,
                turn.sourcePath,
                source.dev,
                source.ino,
                source.size,
                source.mtimeMs,
                source.revision,
                sourceTurnDigest(turn),
                observation.failedAt,
                observedAt,
                validationEpoch,
                validationEpoch,
                observation.receiptCoverage.state,
                observation.receiptCoverage.state === 'incomplete' ? observation.receiptCoverage.reason : null,
            );
        const row = this.find(turn.tool, turn.sessionId);
        return row?.validation_epoch === validationEpoch && row.validated_epoch === validationEpoch ? row : undefined;
    }

    stageSummary(
        tool: ToolName,
        nativeSessionId: string,
        revision: string,
        sourceDigest: string,
        validationEpoch: number,
        summary: SummarizationOutput,
        stagedAt: string,
        projection?: FilteredTurnProjection,
    ): boolean {
        const stored = projection?.included
            ? boundedSanitizedProjection(projection)
            : projection
              ? {
                    userPrompt: '',
                    assistantResponse: '',
                    assistantStructure: null,
                    toolCalls: [],
                    omittedBeforeChars: 0,
                    droppedToolRefCount: 0,
                }
              : undefined;
        const result = this.db
            .prepare(
                `UPDATE open_turns SET
                   staged_at = ?,
                   decisions = ?,
                   pending_items = ?,
                   summarizer_status = ?,
                   durable_included = ?,
                   durable_user_prompt = ?,
                   durable_assistant_response = ?,
                   durable_assistant_structure = ?,
                   durable_tool_calls = ?,
                   durable_omitted_tool_call_count = ?,
                   durable_dropped_tool_ref_count = ?,
                   durable_omitted_before_chars = ?,
                   durable_filter_version = ?
                 WHERE tool = ? AND native_session_id = ? AND source_revision = ? AND source_digest = ?
                   AND validation_epoch = ? AND validated_epoch = ?
                   AND receipt_coverage = 'complete' AND staged_at IS NULL`,
            )
            .run(
                stagedAt,
                JSON.stringify(summary.decisions.map(sanitizeTurnDecision)),
                JSON.stringify(summary.pending_items.map(stripShellSyntax)),
                summary.status,
                projection ? (projection.included ? 1 : 0) : null,
                stored?.userPrompt ?? null,
                stored?.assistantResponse ?? null,
                stored?.assistantStructure ?? null,
                stored ? JSON.stringify(stored.toolCalls) : null,
                projection ? (projection.included ? projection.omittedToolCallCount : 0) : null,
                stored?.droppedToolRefCount ?? null,
                stored?.omittedBeforeChars ?? null,
                projection?.filterVersion ?? null,
                tool,
                nativeSessionId,
                revision,
                sourceDigest,
                validationEpoch,
                validationEpoch,
            );
        return result.changes === 1;
    }

    delete(tool: ToolName, nativeSessionId: string): boolean {
        return this.db.prepare('DELETE FROM open_turns WHERE tool = ? AND native_session_id = ?').run(tool, nativeSessionId).changes > 0;
    }
}
