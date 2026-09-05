import type { Database } from 'better-sqlite3-multiple-ciphers';
import { DURABLE_CAPTURE_MAX_BYTES } from '../config/constants.js';
import type { FilteredTurnProjection } from '../rendering/filtered-turn.js';
import type { ToolName } from '../types/index.js';
import type { ConsentStore } from './consent-store.js';
import { DurableCaptureStore } from './durable-capture-store.js';

export interface DurableCaptureBackfillSession {
    id: number;
    projectId: number;
    tool: ToolName;
    nativeId: string;
    sourcePath: string;
}

export interface DurableCaptureBackfillWork {
    missingTurnIndexes: Set<number>;
}

export type DurableCaptureBackfillRecordResult =
    | { state: 'recorded'; sessionId: number }
    | { state: 'already_recorded'; sessionId: number }
    | { state: 'evicted' }
    | { state: 'unauthorized' }
    | { state: 'memory_missing' };

interface MemoryIdentity {
    memory_id: number;
    session_id: number;
    project_path: string;
}

export class DurableCaptureBackfillStore {
    private readonly durableCapture: DurableCaptureStore;

    constructor(
        private readonly db: Database,
        private readonly consent: ConsentStore,
        private readonly maxBytes = DURABLE_CAPTURE_MAX_BYTES,
    ) {
        this.durableCapture = new DurableCaptureStore(db);
    }

    listCandidates(consentedProjectIds: readonly number[], limit: number): DurableCaptureBackfillSession[] {
        if (consentedProjectIds.length === 0) {
            return [];
        }
        const placeholders = consentedProjectIds.map(() => '?').join(', ');
        return this.db
            .prepare(
                `SELECT s.id, s.project_id, s.tool, s.native_id, s.source_path
                 FROM sessions s
                 LEFT JOIN durable_capture_status dcs ON dcs.session_id = s.id
                 WHERE s.project_id IN (${placeholders})
                   AND EXISTS (SELECT 1 FROM memories m WHERE m.session_id = s.id)
                   AND (
                       dcs.state = 'backfilling'
                       OR (
                           EXISTS (
                               SELECT 1
                               FROM memories m
                               LEFT JOIN filtered_turns ft ON ft.memory_id = m.id
                               WHERE m.session_id = s.id AND ft.memory_id IS NULL
                           )
                           AND (dcs.state IS NULL OR dcs.state NOT IN ('source_unavailable', 'parse_error', 'revoked', 'incognito', 'evicted'))
                       )
                   )
                 ORDER BY s.id
                 LIMIT ?`,
            )
            .all(...consentedProjectIds, limit)
            .map((row) => {
                const session = row as {
                    id: number;
                    project_id: number;
                    tool: ToolName;
                    native_id: string;
                    source_path: string;
                };
                return {
                    id: session.id,
                    projectId: session.project_id,
                    tool: session.tool,
                    nativeId: session.native_id,
                    sourcePath: session.source_path,
                };
            });
    }

    begin(session: DurableCaptureBackfillSession, updatedAt: string): DurableCaptureBackfillWork | undefined {
        const begin = this.db.transaction(() => {
            if (!this.isAuthorizedSession(session)) {
                return undefined;
            }
            const status = this.db.prepare('SELECT state FROM durable_capture_status WHERE session_id = ?').get(session.id) as
                | { state: string }
                | undefined;
            if (status?.state === 'evicted') {
                return undefined;
            }
            const missing = this.db
                .prepare(
                    `SELECT m.turn_index
                     FROM memories m
                     LEFT JOIN filtered_turns ft ON ft.memory_id = m.id
                     WHERE m.session_id = ? AND ft.memory_id IS NULL
                     ORDER BY m.turn_index`,
                )
                .all(session.id) as Array<{ turn_index: number }>;
            this.durableCapture.setStatus(session.id, 'backfilling', updatedAt);
            return { missingTurnIndexes: new Set(missing.map((row) => row.turn_index)) };
        });
        return begin();
    }

    record(
        session: DurableCaptureBackfillSession,
        turnIndex: number,
        projection: FilteredTurnProjection,
        capturedAt: string,
    ): DurableCaptureBackfillRecordResult {
        const record = this.db.transaction((): DurableCaptureBackfillRecordResult => {
            const memory = this.db
                .prepare(
                    `SELECT m.id AS memory_id, m.session_id, p.path AS project_path
                     FROM memories m
                     JOIN sessions s ON s.id = m.session_id
                     JOIN projects p ON p.id = m.project_id
                     WHERE s.tool = ? AND s.native_id = ? AND m.turn_index = ?
                     LIMIT 1`,
                )
                .get(session.tool, session.nativeId, turnIndex) as MemoryIdentity | undefined;
            if (memory === undefined) {
                return { state: 'memory_missing' };
            }
            if (!this.isAuthorizedIdentity(session.tool, session.nativeId, memory.project_path)) {
                return { state: 'unauthorized' };
            }
            const existing = this.db.prepare('SELECT 1 FROM filtered_turns WHERE memory_id = ?').get(memory.memory_id);
            if (existing !== undefined) {
                return { state: 'already_recorded', sessionId: memory.session_id };
            }
            if (this.durableCapture.record(memory.memory_id, memory.session_id, projection, capturedAt, this.maxBytes) === 'not_retained') {
                return { state: 'evicted' };
            }
            // DurableCaptureStore computes live coverage after every insert;
            // keep interrupted backfills distinguishable until the pass makes
            // its terminal coverage check.
            this.durableCapture.setStatus(memory.session_id, 'backfilling', capturedAt);
            return { state: 'recorded', sessionId: memory.session_id };
        });
        return record();
    }

    finish(
        session: DurableCaptureBackfillSession,
        sessionIds: ReadonlySet<number>,
        outcome: 'success' | 'source_unavailable' | 'parse_error',
        updatedAt: string,
    ): void {
        const finish = this.db.transaction(() => {
            if (!this.isAuthorizedSession(session)) {
                return;
            }
            for (const sessionId of sessionIds) {
                const status = this.db.prepare('SELECT state FROM durable_capture_status WHERE session_id = ?').get(sessionId) as
                    | { state: string }
                    | undefined;
                if (status?.state === 'evicted') {
                    continue;
                }
                const identity = this.db
                    .prepare(
                        `SELECT s.tool, s.native_id, p.path AS project_path
                         FROM sessions s
                         JOIN projects p ON p.id = s.project_id
                         WHERE s.id = ?`,
                    )
                    .get(sessionId) as { tool: ToolName; native_id: string; project_path: string } | undefined;
                if (
                    identity === undefined ||
                    identity.tool !== session.tool ||
                    identity.native_id !== session.nativeId ||
                    !this.isAuthorizedIdentity(identity.tool, identity.native_id, identity.project_path)
                ) {
                    continue;
                }
                if (outcome !== 'success') {
                    this.durableCapture.setStatus(sessionId, outcome, updatedAt);
                    continue;
                }
                const missing = this.db
                    .prepare(
                        `SELECT 1
                         FROM memories m
                         LEFT JOIN filtered_turns ft ON ft.memory_id = m.id
                         WHERE m.session_id = ? AND ft.memory_id IS NULL
                         LIMIT 1`,
                    )
                    .get(sessionId);
                if (missing !== undefined) {
                    this.durableCapture.setStatus(sessionId, 'parse_error', updatedAt);
                } else {
                    this.durableCapture.refreshStatus(sessionId, updatedAt);
                }
            }
        });
        finish();
    }

    private isAuthorizedSession(session: DurableCaptureBackfillSession): boolean {
        const current = this.db
            .prepare(
                `SELECT s.project_id, s.tool, s.native_id, s.source_path, p.path AS project_path
                 FROM sessions s
                 JOIN projects p ON p.id = s.project_id
                 WHERE s.id = ?`,
            )
            .get(session.id) as
            | { project_id: number; tool: ToolName; native_id: string; source_path: string; project_path: string }
            | undefined;
        return (
            current !== undefined &&
            current.project_id === session.projectId &&
            current.tool === session.tool &&
            current.native_id === session.nativeId &&
            current.source_path === session.sourcePath &&
            this.isAuthorizedIdentity(current.tool, current.native_id, current.project_path)
        );
    }

    private isAuthorizedIdentity(tool: ToolName, nativeId: string, projectPath: string): boolean {
        return (
            this.consent.consentState(projectPath) === 'approved' &&
            this.db.prepare('SELECT 1 FROM purged_transcripts WHERE tool = ? AND native_id = ?').get(tool, nativeId) === undefined &&
            this.db.prepare('SELECT 1 FROM incognito_transcripts WHERE tool = ? AND native_id = ?').get(tool, nativeId) === undefined
        );
    }
}
