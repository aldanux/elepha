// Read/write facade for summarized memory records.
// Data concerns live in dedicated stores; this class preserves the existing API.

import path from 'node:path';
import type { Database } from 'better-sqlite3-multiple-ciphers';
import { STANDING_RULES_MAX_ACTIVE, STANDING_RULES_MAX_TOTAL_CHARS } from '../config/constants.js';
import { canonicalizeExisting, isWithin, normalizeForCompare, samePath } from '../config/paths.js';
import type { OpenTailObservation, ParsedTurn, SessionRowKind, SessionRowSurface, SummarizationOutput, ToolName } from '../types/index.js';
import { ConsentStore } from './consent-store.js';
import {
    InjectionQuoteBackIncompleteError,
    type InjectionQuoteBackResult,
    type InjectionRow,
    InjectionStore,
    type McpReceiptRow,
    type RecordInjectionInput,
} from './injection-store.js';
import {
    type LiveMemoryRetention,
    type LiveMemoryRetentionPolicy,
    liveMemoryRetentionFor,
    useLiveMemoryRetentionPolicy,
} from './live-memory-retention.js';
import { isRetentionRemoved } from './live-memory-retention-schema.js';
import { type OpenTurnRow, type OpenTurnSourceSnapshot, OpenTurnStore } from './open-turn-store.js';
import { type OpencodeV2HandoffObservation, type OpencodeV2HandoffRow, OpencodeV2HandoffStore } from './opencode-v2-handoff.js';
import { type OpencodeV2PendingRow, OpencodeV2PendingStore } from './opencode-v2-pending.js';
import {
    assertOrphanPlanDatabase,
    assertOrphanPlanFilesystem,
    type NativeSessionIdentity,
    type OrphanEvidence,
    planOrphanPurge,
    verifyOrphanPurge,
} from './orphan-classification.js';

import { ProjectResolver } from './project-resolver.js';
import {
    type ProjectMovePlan,
    type ProjectRow,
    ProjectStore,
    projectAssociationIdentity,
    type ResolvedProjectIdentity,
} from './project-store.js';
import type { SessionRuleRow } from './session-rules-store.js';
import { hydrateSessionRow, type SessionMetadata, type SessionRow, SessionStore } from './session-store.js';
import { ShownSessionListStore } from './shown-session-list-store.js';
import { sourceTurnDigest } from './source-turn-digest.js';
import { SqliteSourceWatermarkStore } from './sqlite-source-watermark-store.js';
import { type StandingRuleRow, StandingRulesStore } from './standing-rules-store.js';
import { minMedianMax, type ProjectCount, type Stats, type StatusCount, type ToolCount, type ToolZeroPaths } from './stats.js';
import { TURN_EMBEDDINGS_TABLE } from './turn-embeddings.js';
import { deleteTurnSearchForTranscript } from './turn-search-index.js';
import { type MemoryRow, TurnStore } from './turn-store.js';

export type { InjectionRow, RecordInjectionInput } from './injection-store.js';
export type { ProjectRow } from './project-store.js';
export type { SessionRow } from './session-store.js';
export type { MemoryRow } from './turn-store.js';
export { hydrateTurnDecisions } from './turn-store.js';

// One project-row group consolidated onto a canonical row. The full mapping is
// returned so the migration remains reviewable.
export interface ProjectMergePlan {
    canonical: ProjectRow;
    gitRoot: string | null;
    merged: ProjectRow[];
}

// Move every direct owner before deleting a project, including caches with cascading foreign keys.
const PROJECT_OWNERSHIP_REFERENCES = [
    ['memories', 'project_id'],
    ['sessions', 'project_id'],
    ['session_rollups', 'project_id'],
    ['open_turns', 'project_id'],
    ['standing_rules', 'project_id'],
    ['session_rules', 'owner_project_id'],
    ['session_embeddings', 'project_id'],
    [TURN_EMBEDDINGS_TABLE, 'project_id'],
] as const;

export interface MemoryStoreOptions {
    // Test seam; production resolves through the Rule 2 subprocess allowlist.
    resolveGitRoot?: (projectPath: string) => string | null;
    // Test seam paired with resolveGitRoot so git-backed project creation stays deterministic.
    resolveGitRemote?: (gitRoot: string) => string | null;
    // Test seam paired with resolveGitRoot so git-backed project creation stays deterministic.
    resolveGitRootCommit?: (gitRoot: string) => string | null;
    // Test seam for the session/segment baseline captured from the same resolved project identity.
    resolveGitCommitCount?: (projectPath: string) => number | null;
    // Test seam for small capacity thresholds and failing backups; production uses the fixed policy.
    liveMemoryRetention?: LiveMemoryRetentionPolicy;
}

export interface IngestedTurnWritePreparation {
    projectIdentity: ResolvedProjectIdentity;
    gitCommitCount: number | null;
}

// What to purge: at most one project scope, optionally narrowed by time.
// The part of an Elepha MCP receipt turn that publishing its receipts reads.
// A full-source replay keeps only this, never the whole parsed turn.
export type McpReceiptEvidence = Pick<
    ParsedTurn,
    'tool' | 'sessionId' | 'projectPath' | 'turnIndex' | 'droppedReason' | 'elephaMcpResultReceipts' | 'validateSource'
>;

export interface PurgeScope {
    orphan?: boolean;
    nativeUnits?: NativeSessionIdentity[];
    sessionIds?: number[];
    // Orphan planning narrows chat rules to these classified identities, across all rule owners.
    sessionRuleNativeUnits?: NativeSessionIdentity[];
    // Include durable rules for the selected scope. Time filters override this intention.
    deleteStandingRules?: boolean;
    // Purge every session belonging to project rows matching this path or display name.
    projectPath?: string;
    // Purge every session belonging to these already-resolved project rows.
    projectIds?: number[];
    // Purge every project row at or below one approved consent root.
    projectRoot?: string;
    // Purge sessions with last_ingested_at >= this ISO timestamp.
    newerThan?: string;
    // Purge sessions with last_ingested_at <= this ISO timestamp.
    olderThan?: string;
    // Purge everything: every session, every project row.
    all?: boolean;
}

export interface PurgeSessionPreview {
    id: number;
    segmentIndex: number;
    nativeId: string;
    title: string | null;
    projectId: number;
    projectPath: string;
    tool: string;
    startedAt: string;
    lastIngestedAt: string;
    turnCount: number;
    filteredTurnCount: number;
    filteredBytes: number;
    // Retained only so post-apply verification can detect orphaned FTS postings
    // after the parent memories and session have been deleted.
    filteredMemoryIds: number[];
}

// A purge preview includes the actual sessions because counts hide
// misclassification.
export interface PurgePlan {
    orphanEvidence?: OrphanEvidence;
    scope: PurgeScope;
    sessions: PurgeSessionPreview[];
    standingRules: Array<StandingRuleRow & { projectPath: string }>;
    sessionRules: Array<SessionRuleRow & { projectPath: string }>;
    // Project rows that will have neither sessions nor retained rules left.
    emptiedProjects: ProjectRow[];
}

// Every capture write of a parsed turn touches its whole native session and
// may create or touch the project its cwd names.

export class MemoryStore {
    private readonly db: Database;
    readonly consent: ConsentStore;
    private readonly projects: ProjectStore;
    private readonly sessions: SessionStore;
    private readonly turns: TurnStore;
    private readonly injections: InjectionStore;
    private readonly openTurns: OpenTurnStore;
    private readonly sqliteSourceWatermarks: SqliteSourceWatermarkStore;
    private readonly opencodeV2Pending: OpencodeV2PendingStore;
    private readonly opencodeV2Handoffs: OpencodeV2HandoffStore;
    readonly shownSessionLists: ShownSessionListStore;
    readonly standingRules: StandingRulesStore;

    constructor(db: Database, options: MemoryStoreOptions = {}) {
        this.db = db;
        this.consent = new ConsentStore(db);
        this.projects = new ProjectStore(db, options);
        this.sessions = new SessionStore(db, (id) => this.projects.getProjectById(id), options.resolveGitCommitCount);
        this.turns = new TurnStore(db, this.sessions);
        this.injections = new InjectionStore(db);
        this.openTurns = new OpenTurnStore(db);
        this.sqliteSourceWatermarks = new SqliteSourceWatermarkStore(db);
        this.opencodeV2Pending = new OpencodeV2PendingStore(db);
        this.opencodeV2Handoffs = new OpencodeV2HandoffStore(db);
        this.shownSessionLists = new ShownSessionListStore(db);
        this.standingRules = new StandingRulesStore(db);
        if (options.liveMemoryRetention !== undefined) {
            useLiveMemoryRetentionPolicy(db, options.liveMemoryRetention);
        }
    }

    get database(): Database {
        return this.db;
    }

    // Every capture write that adds live memory runs through the connection's
    // shared policy, so no caller can bypass the capacity check or its cleanup.
    get liveMemoryRetention(): LiveMemoryRetention {
        return liveMemoryRetentionFor(this.db);
    }

    recordInjection(input: RecordInjectionInput): boolean {
        return this.injections.recordInjection(input);
    }

    hasInjectionBodyPrefix(tool: ToolName, nativeSessionId: string, prefix: string): boolean {
        return this.injections.hasBodyPrefix(tool, nativeSessionId, prefix);
    }

    countInjectionBodyPrefix(tool: ToolName, nativeSessionId: string, prefix: string): number {
        return this.injections.countBodyPrefix(tool, nativeSessionId, prefix);
    }

    injectionsForSession(tool: ToolName, nativeSessionId: string, atOrBefore: string): InjectionRow[] {
        return this.injections.injectionsForSession(tool, nativeSessionId, atOrBefore);
    }

    mcpReceiptsForSession(tool: ToolName, nativeSessionId: string, sourceGeneration: number): McpReceiptRow[] {
        return this.injections.mcpReceiptsForSession(tool, nativeSessionId, sourceGeneration);
    }

    isInjectionQuoteBack(turn: ParsedTurn): boolean {
        return this.injections.quoteBackStatus(turn) === 'match';
    }

    injectionQuoteBackStatus(turn: ParsedTurn): InjectionQuoteBackResult {
        return this.injections.quoteBackStatus(turn);
    }

    hasMemoryForNativeTurn(tool: ToolName, nativeId: string, turnIndex: number): boolean {
        return this.turns.hasMemoryForNativeTurn(tool, nativeId, turnIndex);
    }

    upsertProject(projectPath: string): ProjectRow {
        return this.projects.upsertProject(projectPath);
    }

    getProjectById(id: number): ProjectRow | undefined {
        return this.projects.getProjectById(id);
    }

    findProject(query: string): ProjectRow | undefined {
        return this.projects.findProject(query);
    }

    listProjects(): ProjectRow[] {
        return this.projects.listProjects();
    }

    upsertSession(tool: ToolName, nativeId: string, projectId: number, sourcePath: string, meta?: SessionMetadata): SessionRow {
        return this.db.transaction(() => this.sessions.upsertSession(tool, nativeId, projectId, sourcePath, meta))();
    }

    findSession(tool: ToolName, nativeId: string): SessionRow | undefined {
        return this.sessions.findSession(tool, nativeId);
    }

    updateSessionTitle(sessionDbId: number, turn: Pick<ParsedTurn, 'aiTitle' | 'userMessage'>): void {
        const identity = this.db.prepare('SELECT tool, native_id FROM sessions WHERE id = ?').get(sessionDbId) as
            | { tool: ToolName; native_id: string }
            | undefined;
        if (identity === undefined) {
            return;
        }
        this.liveMemoryRetention.run({ tool: identity.tool, nativeId: identity.native_id }, () =>
            this.db.transaction(() => this.sessions.updateSessionTitle(sessionDbId, turn))(),
        );
    }

    // Automatic retention removed this native session. Unlike a purge, a
    // restored pre-cleanup backup brings it back.
    isTranscriptRetentionRemoved(tool: ToolName, nativeId: string): boolean {
        return isRetentionRemoved(this.db, tool, nativeId);
    }

    // Capture never writes a purged or retention-removed native session.
    isTranscriptCaptureBlocked(tool: ToolName, nativeId: string): boolean {
        return this.isTranscriptPurged(tool, nativeId) || this.isTranscriptRetentionRemoved(tool, nativeId);
    }

    // A purge freezes the whole native transcript, across all its segments.
    isTranscriptPurged(tool: string, nativeId: string): boolean {
        return this.db.prepare('SELECT 1 FROM purged_transcripts WHERE tool = ? AND native_id = ?').get(tool, nativeId) !== undefined;
    }

    // Records only the stable provider/session identity, never transcript content.
    recordIncognitoTranscript(tool: ToolName, nativeId: string): void {
        const record = this.db.transaction(() => {
            this.db
                .prepare('INSERT OR IGNORE INTO incognito_transcripts (tool, native_id, tombstoned_at) VALUES (?, ?, ?)')
                .run(tool, nativeId, new Date().toISOString());
            this.db.prepare('DELETE FROM mcp_receipts WHERE tool = ? AND native_session_id = ?').run(tool, nativeId);
            this.db.prepare('DELETE FROM source_generations WHERE tool = ? AND native_id = ?').run(tool, nativeId);
            this.db.prepare('DELETE FROM open_turns WHERE tool = ? AND native_session_id = ?').run(tool, nativeId);
            this.db
                .prepare('DELETE FROM session_embeddings WHERE session_id IN (SELECT id FROM sessions WHERE tool = ? AND native_id = ?)')
                .run(tool, nativeId);
            // Delete the child explicitly: SQLite does not reliably run this
            // table's FTS cleanup trigger for an FK cascade.
            this.db
                .prepare(
                    `DELETE FROM filtered_turns
                     WHERE memory_id IN (
                         SELECT m.id
                         FROM memories m
                         JOIN sessions s ON s.id = m.session_id
                         WHERE s.tool = ? AND s.native_id = ?
                     )`,
                )
                .run(tool, nativeId);
            // Memory rows survive incognito, so their delete trigger cannot
            // withdraw the derived search coverage.
            deleteTurnSearchForTranscript(this.db, tool, nativeId);
            this.db
                .prepare(`DELETE FROM task_state_manifests WHERE memory_id IN (
                SELECT m.id FROM memories m JOIN sessions s ON s.id = m.session_id
                WHERE s.tool = ? AND s.native_id = ?
            )`)
                .run(tool, nativeId);
            this.db
                .prepare(
                    `DELETE FROM durable_capture_status
                     WHERE session_id IN (
                         SELECT id FROM sessions WHERE tool = ? AND native_id = ?
                     )`,
                )
                .run(tool, nativeId);
        });
        record();
    }

    isTranscriptIncognito(tool: ToolName, nativeId: string): boolean {
        return this.db.prepare('SELECT 1 FROM incognito_transcripts WHERE tool = ? AND native_id = ?').get(tool, nativeId) !== undefined;
    }

    startNextSegment(
        previous: SessionRow,
        projectId: number,
        sourcePath: string,
        meta?: { surface?: SessionRowSurface | null; gitBranch?: string | null; kind?: SessionRowKind | null; customTitle?: string },
    ): SessionRow {
        return this.db.transaction(() => this.sessions.startNextSegment(previous, projectId, sourcePath, meta))();
    }

    listSessionsForRollupRebuild(currentVersion: number): SessionRow[] {
        return this.sessions.listSessionsForRollupRebuild(currentVersion);
    }

    listOpenSessions(): SessionRow[] {
        return this.sessions.listOpenSessions();
    }

    getSessionCursor(tool: ToolName, nativeId: string): string | undefined {
        return this.sessions.getSessionCursor(tool, nativeId);
    }

    getSessionResume(tool: ToolName, nativeId: string): ReturnType<SessionStore['getSessionResume']> {
        return this.sessions.getSessionResume(tool, nativeId);
    }

    findOpenTurn(tool: ToolName, nativeId: string): OpenTurnRow | undefined {
        return this.openTurns.find(tool, nativeId);
    }

    beginOpenTurnValidation(tool: ToolName, nativeId: string, minimumEpoch: number): number {
        return this.db.transaction(() => this.openTurns.beginValidation(tool, nativeId, minimumEpoch))();
    }

    invalidateOpenTurnIfSourceChanged(tool: ToolName, nativeId: string, sourceGeneration: number, source: OpenTurnSourceSnapshot): boolean {
        return this.db.transaction(() => this.openTurns.invalidateChangedSource(tool, nativeId, sourceGeneration, source))();
    }

    observeOpenTurn(
        observation: OpenTailObservation,
        meta: SessionMetadata,
        sourceGeneration: number,
        source: OpenTurnSourceSnapshot,
        observedAt: string,
        validationEpoch = 0,
    ): OpenTurnRow | undefined {
        const turn = observation.receiptCoverage.turn;
        const resolved = this.resolveTurnGitValues(turn, false);
        const observe = this.db.transaction(() => {
            if (this.recordIncognitoIfWriteBlocked(turn) || turn.validateSource?.() === false) {
                return undefined;
            }
            const quoteBackStatus = this.injections.quoteBackStatus(turn);
            if (quoteBackStatus === 'incomplete') {
                throw new InjectionQuoteBackIncompleteError(`Open-turn observation for ${turn.sessionId}`);
            }
            if (quoteBackStatus === 'match') {
                return undefined;
            }

            const project = this.projects.upsertProject(turn.projectPath, resolved.projectIdentity);
            const session = this.sessions.upsertSession(
                turn.tool,
                turn.sessionId,
                project.id,
                turn.sourcePath,
                meta,
                resolved.gitCommitCount,
            );
            if (
                observation.receiptCoverage.state === 'complete' &&
                turn.droppedReason === 'elepha-mcp' &&
                !this.injections.recordElephaMcpReceipts(turn, sourceGeneration)
            ) {
                throw new Error('failed to persist open-turn Elepha MCP result receipt');
            }
            return this.openTurns.observe(observation, session.id, project.id, sourceGeneration, source, observedAt, validationEpoch);
        });
        return this.liveMemoryRetention.run({ tool: turn.tool, nativeId: turn.sessionId }, () => observe());
    }

    stageOpenTurnSummary(
        tool: ToolName,
        nativeId: string,
        sourceRevision: string,
        sourceDigest: string,
        summary: SummarizationOutput,
        stagedAt: string,
        projection?: Parameters<OpenTurnStore['stageSummary']>[7],
        projectPath?: string,
        validateSource?: () => boolean,
        validationEpoch?: number,
    ): boolean {
        const stage = this.db.transaction(() => {
            const row = this.openTurns.find(tool, nativeId);
            if (
                row === undefined ||
                row.source_revision !== sourceRevision ||
                this.isTranscriptCaptureBlocked(tool, nativeId) ||
                this.isTranscriptIncognito(tool, nativeId) ||
                validateSource?.() === false
            ) {
                return false;
            }
            const project = projectPath ?? this.projects.getProjectById(row.project_id)?.path;
            if (project === undefined || this.consent.consentState(project) !== 'approved') {
                return false;
            }
            const expectedValidationEpoch = validationEpoch ?? row.validation_epoch;
            return this.openTurns.stageSummary(
                tool,
                nativeId,
                sourceRevision,
                sourceDigest,
                expectedValidationEpoch,
                summary,
                stagedAt,
                projection,
            );
        });
        return this.liveMemoryRetention.run({ tool, nativeId }, () => stage());
    }

    getSqliteSourceCursor(tool: ToolName, sourcePath: string): { watermark: number; cursorId?: string } | undefined {
        return this.sqliteSourceWatermarks.getCursor(tool, sourcePath);
    }

    setSqliteSourceCursor(tool: ToolName, sourcePath: string, cursor: { watermark: number; cursorId: string }): void {
        this.sqliteSourceWatermarks.setCursor(tool, sourcePath, cursor);
    }

    listOpencodeV2Pending(sourcePath: string, limit: number): OpencodeV2PendingRow[] {
        return this.opencodeV2Pending.list(sourcePath, limit);
    }

    countOpencodeV2Pending(sourcePath: string): number {
        return this.opencodeV2Pending.count(sourcePath);
    }

    upsertOpencodeV2Pending(
        sourcePath: string,
        nativeId: string,
        projectPath: string,
        revision: { seq: number; updated: number },
        needsContinuation: boolean,
        resumeCursor?: string,
    ): boolean {
        return this.db.transaction(() => {
            if (
                this.consent.isRefusedForCapture(projectPath) ||
                this.consent.consentState(projectPath) !== 'approved' ||
                this.isTranscriptCaptureBlocked('opencode', nativeId) ||
                this.isTranscriptIncognito('opencode', nativeId)
            ) {
                return false;
            }
            this.opencodeV2Pending.upsert(sourcePath, nativeId, revision, needsContinuation, resumeCursor);
            return true;
        })();
    }

    touchOpencodeV2Pending(sourcePath: string, nativeId: string, projectPath: string): void {
        this.db.transaction(() => {
            if (
                this.consent.isRefusedForCapture(projectPath) ||
                this.consent.consentState(projectPath) !== 'approved' ||
                this.isTranscriptCaptureBlocked('opencode', nativeId) ||
                this.isTranscriptIncognito('opencode', nativeId)
            ) {
                return;
            }
            this.opencodeV2Pending.touch(sourcePath, nativeId);
        })();
    }

    deleteOpencodeV2Pending(sourcePath: string, nativeId: string): void {
        this.opencodeV2Pending.delete(sourcePath, nativeId);
    }

    getOpencodeV2Handoff(nativeId: string): OpencodeV2HandoffRow | undefined {
        return this.opencodeV2Handoffs.get(nativeId);
    }

    listOpencodeV2HandoffContinuations(sourcePath: string, limit: number): string[] {
        return this.opencodeV2Handoffs.listNeedingContinuation(sourcePath, limit);
    }

    // Handoff state is identity-only, but it is still capture bookkeeping, so
    // the consent and tombstone decision shares the write transaction. False
    // also when the native id is bound to a different source path.
    recordOpencodeV2Handoff(sourcePath: string, nativeId: string, projectPath: string, observation: OpencodeV2HandoffObservation): boolean {
        return this.db.transaction(() => {
            if (
                this.consent.isRefusedForCapture(projectPath) ||
                this.consent.consentState(projectPath) !== 'approved' ||
                this.isTranscriptCaptureBlocked('opencode', nativeId) ||
                this.isTranscriptIncognito('opencode', nativeId)
            ) {
                return false;
            }
            return this.opencodeV2Handoffs.upsert(nativeId, sourcePath, observation);
        })();
    }

    // V1 turn indexes count V1 user messages while V2 indexes are provider
    // sequence numbers, so the two ranges can collide within one native
    // session. V2 indexes start strictly above every stored V1 index.
    opencodeV1TurnIndexOffset(nativeId: string): number {
        const row = this.db
            .prepare(`SELECT MAX(m.turn_index) AS max_index FROM memories m JOIN sessions s ON s.id = m.session_id
                WHERE s.tool = 'opencode' AND s.native_id = ? AND s.source_format = 'native'`)
            .get(nativeId) as { max_index: number | null };
        return (row.max_index ?? -1) + 1;
    }

    getLastIngestedAt(): string | undefined {
        return this.turns.getLastIngestedAt();
    }

    recordTurn(turn: ParsedTurn, sessionDbId: number, projectId: number, summary: SummarizationOutput, durableCapture = false): boolean {
        return this.liveMemoryRetention.run({ tool: turn.tool, nativeId: turn.sessionId }, () =>
            this.db.transaction(() => this.turns.recordTurn(turn, sessionDbId, projectId, summary, durableCapture))(),
        );
    }

    // Creates the project/session and records one live turn as one SQLite
    // transaction. Write blockers and native-turn dedupe are authoritative
    // here: an earlier scan check may avoid work, but it cannot make a
    // persistence decision across concurrent writers.
    recordIngestedTurn(
        turn: ParsedTurn,
        meta: SessionMetadata,
        startNextSegment: boolean,
        summary: SummarizationOutput,
        durableCapture = false,
        preparation?: IngestedTurnWritePreparation,
    ): { project: ProjectRow; session: SessionRow; inserted: boolean } | undefined {
        const resolved = preparation ?? this.resolveTurnGitValues(turn, startNextSegment);
        const write = this.db.transaction(() => {
            if (this.recordIncognitoIfWriteBlocked(turn) || turn.validateSource?.() === false) {
                return undefined;
            }
            if (turn.droppedReason !== undefined) {
                return undefined;
            }
            const quoteBackStatus = this.injections.quoteBackStatus(turn);
            if (quoteBackStatus === 'incomplete') {
                throw new InjectionQuoteBackIncompleteError(`Turn ingestion for ${turn.sessionId}`);
            }
            if (quoteBackStatus === 'match') {
                return undefined;
            }
            if (this.turns.hasMemoryForNativeTurn(turn.tool, turn.sessionId, turn.turnIndex)) {
                return undefined;
            }

            const project = this.projects.upsertProject(turn.projectPath, resolved.projectIdentity);
            let session = this.sessions.upsertSession(
                turn.tool,
                turn.sessionId,
                project.id,
                turn.sourcePath,
                meta,
                resolved.gitCommitCount,
            );
            if (startNextSegment) {
                session = this.sessions.startNextSegment(session, project.id, turn.sourcePath, meta, resolved.gitCommitCount);
            }
            // The staged projection describes this same logical turn. Remove it
            // inside the final-write transaction so the canonical replacement is
            // measured without its staged copy.
            this.openTurns.delete(turn.tool, turn.sessionId);
            return {
                project,
                session,
                inserted: this.turns.recordTurnInTransaction(turn, session.id, project.id, summary, durableCapture),
            };
        });
        return this.liveMemoryRetention.run({ tool: turn.tool, nativeId: turn.sessionId }, () => write());
    }

    // Refresh a verified logical prefix after atomic source replacement without creating memories.
    refreshExistingSourceTurn(turn: ParsedTurn): void {
        this.db.transaction(() => {
            if (this.recordIncognitoIfWriteBlocked(turn) || turn.validateSource?.() === false) {
                return;
            }
            const memory = this.db
                .prepare(`SELECT m.session_id, m.source_digest FROM memories m
                JOIN sessions s ON s.id = m.session_id WHERE s.tool = ? AND s.native_id = ? AND m.turn_index = ?`)
                .get(turn.tool, turn.sessionId, turn.turnIndex) as { session_id: number; source_digest: string } | undefined;
            if (memory?.source_digest !== sourceTurnDigest(turn)) {
                return;
            }

            this.sessions.advanceSessionCursor(memory.session_id, turn);
            this.sessions.updateTrailingState(memory.session_id, turn);
            this.openTurns.delete(turn.tool, turn.sessionId);
        })();
    }

    recordDroppedTurn(turn: ParsedTurn, meta: SessionMetadata): boolean {
        if (turn.droppedReason === 'elepha-mcp' && (turn.elephaMcpResultReceipts?.length ?? 0) === 0) {
            return false;
        }
        const resolved = this.resolveTurnGitValues(turn, false);
        const write = this.db.transaction(() => {
            if (this.recordIncognitoIfWriteBlocked(turn) || turn.validateSource?.() === false) {
                return false;
            }

            const project = this.projects.upsertProject(turn.projectPath, resolved.projectIdentity);
            const session = this.sessions.upsertSession(
                turn.tool,
                turn.sessionId,
                project.id,
                turn.sourcePath,
                meta,
                resolved.gitCommitCount,
            );
            if (!this.injections.recordElephaMcpReceipts(turn)) {
                throw new Error('failed to persist Elepha MCP result receipt');
            }
            this.sessions.advanceSessionCursor(session.id, turn);
            this.openTurns.delete(turn.tool, turn.sessionId);
            return true;
        });
        try {
            return this.liveMemoryRetention.run({ tool: turn.tool, nativeId: turn.sessionId }, () => write());
        } catch (error) {
            if ((error as Error).message === 'failed to persist Elepha MCP result receipt') {
                return false;
            }
            throw error;
        }
    }

    learnElephaMcpReceipts(turn: ParsedTurn, expectedSessionId?: number): boolean {
        if (turn.droppedReason !== 'elepha-mcp' || (turn.elephaMcpResultReceipts?.length ?? 0) === 0) {
            return turn.droppedReason !== 'elepha-mcp';
        }
        try {
            return this.db.transaction(() => {
                if (this.recordIncognitoIfWriteBlocked(turn) || turn.validateSource?.() === false) {
                    return false;
                }
                if (expectedSessionId !== undefined) {
                    const session = this.db
                        .prepare('SELECT id FROM sessions WHERE id = ? AND tool = ? AND native_id = ?')
                        .get(expectedSessionId, turn.tool, turn.sessionId) as { id: number } | undefined;
                    if (session === undefined) {
                        return false;
                    }
                }

                if (!this.injections.recordElephaMcpReceipts(turn)) {
                    throw new Error('failed to persist Elepha MCP result receipt');
                }
                return true;
            })();
        } catch (error) {
            if ((error as Error).message === 'failed to persist Elepha MCP result receipt') {
                return false;
            }
            throw error;
        }
    }

    publishElephaMcpReceiptBatch(
        turns: readonly McpReceiptEvidence[],
        expectedSessionId: number | undefined,
        tool: ToolName,
        nativeSessionId: string,
        expectedSourceGeneration: number,
    ): boolean {
        try {
            const write = () => {
                const session =
                    expectedSessionId === undefined
                        ? undefined
                        : (this.db
                              .prepare('SELECT id FROM sessions WHERE id = ? AND tool = ? AND native_id = ?')
                              .get(expectedSessionId, tool, nativeSessionId) as { id: number } | undefined);
                if (
                    (expectedSessionId !== undefined && session === undefined) ||
                    this.injections.currentSourceGeneration(tool, nativeSessionId) !== expectedSourceGeneration
                ) {
                    throw new Error('failed to persist Elepha MCP result receipt batch');
                }
                for (const turn of turns) {
                    if (
                        turn.tool !== tool ||
                        turn.sessionId !== nativeSessionId ||
                        turn.droppedReason !== 'elepha-mcp' ||
                        (turn.elephaMcpResultReceipts?.length ?? 0) === 0 ||
                        this.recordIncognitoIfWriteBlocked(turn) ||
                        turn.validateSource?.() === false
                    ) {
                        throw new Error('failed to persist Elepha MCP result receipt batch');
                    }
                }

                for (const turn of turns) {
                    if (!this.injections.recordElephaMcpReceipts(turn, expectedSourceGeneration)) {
                        throw new Error('failed to persist Elepha MCP result receipt batch');
                    }
                }
                if (turns.some((turn) => turn.validateSource?.() === false)) {
                    throw new Error('failed to persist Elepha MCP result receipt batch');
                }
                return true;
            };
            return this.db.transaction(write)();
        } catch (error) {
            if ((error as Error).message === 'failed to persist Elepha MCP result receipt batch') {
                return false;
            }
            throw error;
        }
    }

    recordQuoteBackTurn(turn: ParsedTurn): boolean {
        return this.db.transaction(() => {
            if (this.recordIncognitoIfWriteBlocked(turn) || turn.validateSource?.() === false) {
                return false;
            }
            if (turn.droppedReason !== undefined || this.injections.quoteBackStatus(turn) !== 'match') {
                return false;
            }
            const session = this.sessions.findSession(turn.tool, turn.sessionId);

            if (session) {
                this.sessions.advanceSessionCursor(session.id, turn);
            }
            this.openTurns.delete(turn.tool, turn.sessionId);
            return true;
        })();
    }

    private resolveTurnGitValues(turn: ParsedTurn, startNextSegment: boolean): IngestedTurnWritePreparation {
        const projectIdentity = this.projects.resolveProjectIdentity(turn.projectPath);
        const existingSession = this.sessions.findSession(turn.tool, turn.sessionId);
        const needsGitCommitCount = existingSession === undefined || startNextSegment;
        return {
            projectIdentity,
            gitCommitCount: needsGitCommitCount
                ? this.sessions.gitCommitCount(projectIdentity.gitRoot ?? turn.projectPath)
                : existingSession.git_commit_count,
        };
    }

    // The final consent and tombstone decision must share the transaction that would mutate capture rows.
    private recordIncognitoIfWriteBlocked(turn: Pick<ParsedTurn, 'tool' | 'sessionId' | 'projectPath'>): boolean {
        // A retention removal is not a privacy decision, so it blocks the write
        // without recording an incognito tombstone a restore would carry.
        if (this.isTranscriptRetentionRemoved(turn.tool, turn.sessionId)) {
            return true;
        }
        const consentState = this.consent.consentState(turn.projectPath);
        const mustRecordIncognito =
            consentState === 'denied' ||
            this.isTranscriptPurged(turn.tool, turn.sessionId) ||
            this.isTranscriptIncognito(turn.tool, turn.sessionId);
        if (mustRecordIncognito) {
            this.recordIncognitoTranscript(turn.tool, turn.sessionId);
        }
        return consentState !== 'approved' || mustRecordIncognito;
    }

    reingestTurn(
        turn: ParsedTurn,
        sessionDbId: number,
        projectId: number,
        summary: SummarizationOutput,
        quoteBackPrevalidated = false,
        durableCapture = false,
    ): boolean {
        const reingest = this.db.transaction(() => {
            if (this.recordIncognitoIfWriteBlocked(turn) || turn.validateSource?.() === false || turn.droppedReason !== undefined) {
                return false;
            }
            if (!quoteBackPrevalidated) {
                const quoteBackStatus = this.injections.quoteBackStatus(turn);
                if (quoteBackStatus === 'incomplete') {
                    throw new InjectionQuoteBackIncompleteError(`Reingest for ${turn.sessionId}`);
                }
                if (quoteBackStatus === 'match') {
                    return false;
                }
            }
            this.turns.reingestTurn(turn, sessionDbId, projectId, summary, durableCapture);
            const reportingMemory = this.db
                .prepare('SELECT id FROM memories WHERE session_id = ? AND turn_index = ?')
                .get(sessionDbId, turn.turnIndex) as { id: number };
            this.db.prepare('DELETE FROM task_state_manifests WHERE memory_id = ?').run(reportingMemory.id);
            return true;
        });
        return this.liveMemoryRetention.run({ tool: turn.tool, nativeId: turn.sessionId }, () => reingest());
    }

    listSessionsWithMemoriesSince(sinceIso: string): SessionRow[] {
        return this.sessions.listSessionsWithMemoriesSince(sinceIso);
    }

    // Consolidates project rows that identify the same repository even when a
    // checkout was renamed or moved. The live git root identifies the working
    // copy; stored remote and root-commit identity are fallbacks only for rows
    // whose paths no longer resolve.
    //
    // When a group has a live checkout, its canonical row is chosen from those
    // live members, preferring the repository root and then the shallowest
    // path. Without a live checkout, the shallowest row survives but keeps its
    // existing path and git root rather than being rewritten to stale data.
    planRekeyProjectsByIdentity(resolveGitRoot: (path: string) => string | null): ProjectMergePlan[] {
        const groups = new Map<string, Array<{ project: ProjectRow; gitRoot: string | null }>>();
        for (const project of this.listProjects()) {
            const gitRoot = project.path ? resolveGitRoot(project.path) : null;
            const key = gitRoot !== null ? normalizeForCompare(gitRoot) : project.git_remote || project.git_root_commit;
            if (!key) {
                continue;
            }
            const members = groups.get(key);
            if (members) {
                members.push({ project, gitRoot });
            } else {
                groups.set(key, [{ project, gitRoot }]);
            }
        }

        const plans: ProjectMergePlan[] = [];
        for (const members of groups.values()) {
            const liveMembers = members.filter((member) => member.gitRoot !== null);
            const candidates = liveMembers.length > 0 ? liveMembers : members;
            const canonicalMember =
                candidates.find((member) => member.gitRoot !== null && samePath(member.project.path, member.gitRoot)) ??
                candidates.reduce((shallowest, member) =>
                    member.project.path.split('/').length < shallowest.project.path.split('/').length ? member : shallowest,
                );
            const gitRoot = canonicalMember.gitRoot;
            const requiresCanonicalization =
                gitRoot !== null &&
                (!samePath(canonicalMember.project.path, gitRoot) || canonicalMember.project.display_name !== path.basename(gitRoot));
            if (members.length < 2 && !requiresCanonicalization) {
                continue;
            }
            plans.push({
                canonical: canonicalMember.project,
                gitRoot,
                merged: members.map((member) => member.project).filter((member) => member.id !== canonicalMember.project.id),
            });
        }
        return plans;
    }

    // Applies and returns the same plan in one transaction for reporting.
    rekeyProjectsByIdentity(resolveGitRoot: (path: string) => string | null): ProjectMergePlan[] {
        const plans = this.planRekeyProjectsByIdentity(resolveGitRoot);

        const apply = this.db.transaction(() => {
            // A merge can join formerly independent rule budgets. Include existing
            // logical membership, then validate all resulting groups before writing.
            const groups = new ProjectResolver(this.db).listStored().map((project) => new Set(project.projectIds));
            for (const plan of plans) {
                const ids = new Set([plan.canonical.id, ...plan.merged.map((project) => project.id)]);
                for (let index = groups.length - 1; index >= 0; index--) {
                    const group = groups[index];
                    if (group !== undefined && [...group].some((id) => ids.has(id))) {
                        for (const id of group) {
                            ids.add(id);
                        }
                        groups.splice(index, 1);
                    }
                }
                groups.push(ids);
            }
            const affected = new Set(plans.flatMap((plan) => [plan.canonical.id, ...plan.merged.map((project) => project.id)]));
            for (const group of groups.filter((ids) => [...ids].some((id) => affected.has(id)))) {
                this.assertProjectRuleBudget(group, 'Rekey');
            }
            for (const plan of plans) {
                for (const victim of plan.merged) {
                    this.moveProjectOwnership(victim.id, plan.canonical.id);
                    this.db.prepare('DELETE FROM projects WHERE id = ?').run(victim.id);
                }
                if (plan.gitRoot !== null) {
                    this.db
                        .prepare('UPDATE projects SET path = ?, display_name = ?, git_root = ? WHERE id = ?')
                        .run(plan.gitRoot, path.basename(plan.gitRoot), plan.gitRoot, plan.canonical.id);
                }
            }
        });
        apply();
        return plans;
    }

    private assertProjectRuleBudget(group: ReadonlySet<number>, operation: 'Rekey' | 'Move'): void {
        const rules = this.standingRules.list([...group]);
        const texts = rules.map((rule) => rule.text);
        const reason =
            new Set(texts).size !== texts.length
                ? 'duplicate standing rule text'
                : rules.length > STANDING_RULES_MAX_ACTIVE
                  ? 'standing rule count limit'
                  : texts.reduce((sum, text) => sum + text.length, 0) > STANDING_RULES_MAX_TOTAL_CHARS
                    ? 'standing rule character limit'
                    : undefined;
        if (reason !== undefined) {
            throw new Error(
                operation === 'Rekey'
                    ? `Rekey refused: ${reason} for project ids ${[...group].join(', ')}; rule ULIDs: ${rules.map((rule) => rule.ulid).join(', ')}.`
                    : `Refusing move-project: ${reason}.`,
            );
        }
        const projectIds = [...group];
        const sessionRules = this.db
            .prepare(
                `SELECT id, ulid, tool, native_session_id, checkout_anchor, owner_project_id, text, created_at
                         FROM session_rules WHERE owner_project_id IN (${projectIds.map(() => '?').join(',')}) ORDER BY id`,
            )
            .all(...projectIds) as SessionRuleRow[];
        const chatScopes = new Map<string, SessionRuleRow[]>();
        for (const rule of sessionRules) {
            const key = JSON.stringify([rule.tool, rule.native_session_id, rule.checkout_anchor]);
            const scoped = chatScopes.get(key) ?? [];
            scoped.push(rule);
            chatScopes.set(key, scoped);
        }
        for (const scoped of chatScopes.values()) {
            const texts = scoped.map((rule) => rule.text);
            const reason =
                new Set(texts).size !== texts.length
                    ? 'duplicate chat rule text'
                    : scoped.length > STANDING_RULES_MAX_ACTIVE
                      ? 'chat rule count limit'
                      : texts.reduce((sum, text) => sum + text.length, 0) > STANDING_RULES_MAX_TOTAL_CHARS
                        ? 'chat rule character limit'
                        : undefined;
            if (reason !== undefined) {
                throw new Error(
                    operation === 'Rekey'
                        ? `Rekey refused: ${reason} for project ids ${projectIds.join(', ')}; rule ULIDs: ${scoped.map((rule) => rule.ulid).join(', ')}.`
                        : `Refusing move-project: ${reason}.`,
                );
            }
        }
    }

    private moveProjectOwnership(fromId: number, toId: number): void {
        for (const [table, column] of PROJECT_OWNERSHIP_REFERENCES) {
            this.db.prepare(`UPDATE ${table} SET ${column} = ? WHERE ${column} = ?`).run(toId, fromId);
        }
    }

    planMoveProject(from: string, to: string): ProjectMovePlan {
        return this.projects.planMoveProject(from, to, this.consent);
    }

    applyProjectMove(plan: ProjectMovePlan): void {
        // Finish filesystem checks before taking the writer lock, then repeat decisive consent inside it.
        this.projects.assertMoveDestination(plan, this.consent);
        this.db
            .transaction(() => {
                this.projects.assertMoveAssociations(plan);
                if (
                    this.consent.consentStateForCanonicalPath(plan.to) !== 'approved' ||
                    this.consent.consentStateForCanonicalPath(plan.destinationInput) === 'denied'
                ) {
                    throw new Error(`Refusing move-project: capture is not authorized for ${plan.to}.`);
                }
                // The mapping is frozen, but activity dates must come from the current transaction.
                const source = plan.source && this.getProjectById(plan.source.id);
                const destination = plan.destination && this.getProjectById(plan.destination.id);
                if (!source || source.id === destination?.id) {
                    this.verifyProjectMove(plan);
                    return;
                }
                const ownerId = destination?.id ?? source.id;
                const selectedIds = new Set([source.id, ownerId]);
                const before = PROJECT_OWNERSHIP_REFERENCES.map(
                    ([table, column]) =>
                        (
                            this.db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${column} IN (?, ?)`).get(source.id, ownerId) as {
                                count: number;
                            }
                        ).count,
                );
                // Checkout anchors are serving locations, unlike the immutable transcript source paths.
                const rules = this.db
                    .prepare('SELECT id, checkout_anchor FROM session_rules WHERE owner_project_id = ?')
                    .all(source.id) as Array<{ id: number; checkout_anchor: string }>;
                for (const rule of rules) {
                    if (samePath(path.resolve(rule.checkout_anchor), plan.from)) {
                        this.db.prepare('UPDATE session_rules SET checkout_anchor = ? WHERE id = ?').run(plan.gitRoot ?? plan.to, rule.id);
                    }
                }
                this.assertProjectRuleBudget(selectedIds, 'Move');
                if (ownerId !== source.id) {
                    this.moveProjectOwnership(source.id, ownerId);
                    this.db.prepare('DELETE FROM projects WHERE id = ?').run(source.id);
                }
                this.db
                    .prepare(`UPDATE projects SET path = ?, display_name = ?, git_root = ?,
                        git_remote = COALESCE(git_remote, ?), git_root_commit = COALESCE(git_root_commit, ?),
                        first_seen_at = MIN(first_seen_at, ?), last_seen_at = MAX(last_seen_at, ?)
                        WHERE id = ?`)
                    .run(
                        plan.to,
                        destination?.display_name ?? path.basename(plan.to),
                        plan.gitRoot,
                        source.git_remote,
                        source.git_root_commit,
                        source.first_seen_at,
                        source.last_seen_at,
                        ownerId,
                    );
                for (const [index, [table, column]] of PROJECT_OWNERSHIP_REFERENCES.entries()) {
                    const after = this.db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${column} = ?`).get(ownerId) as {
                        count: number;
                    };
                    if (after.count !== before[index]) {
                        throw new Error(`Move-project verification failed: dependent ownership changed in ${table}.`);
                    }
                }
                // Verification failures must roll back the relocation too, before capture resumes.
                this.verifyProjectMove(plan);
            })
            .immediate();
    }

    verifyProjectMove(plan: ProjectMovePlan): void {
        const ownerId = plan.destination?.id ?? plan.source?.id;
        const destination = ownerId === undefined ? undefined : this.getProjectById(ownerId);
        if (
            !destination ||
            !samePath(path.resolve(destination.path), plan.to) ||
            destination.git_root !== plan.gitRoot ||
            (plan.source && plan.source.id !== ownerId && this.getProjectById(plan.source.id) !== undefined) ||
            (this.db.pragma('foreign_key_check') as unknown[]).length > 0
        ) {
            throw new Error('Move-project verification failed.');
        }
    }

    // Project rows matching a purge query: exact path match if one exists,
    // otherwise every row whose path or display_name contains the query.
    // Unlike findProject() (single best guess, for UX lookups), this returns
    // every match because one project can be fragmented across multiple rows,
    // and a purge that only
    // hit the first match would silently leave the rest behind.
    findProjectsForPurge(query: string): ProjectRow[] {
        if (query.trim().length === 0) {
            return [];
        }
        const rows = this.listProjects();
        const exact = rows.filter((r) => r.path === query);
        if (exact.length > 0) {
            return exact;
        }
        return rows.filter((r) => r.path.includes(query) || r.display_name?.includes(query));
    }

    // Computes what a purge would delete, without deleting anything. The
    // actual session list, not just a count: aggregates hide misclassification.
    planPurge(scope: PurgeScope): PurgePlan {
        if (scope.orphan) {
            return planOrphanPurge(this, scope);
        }
        const projects = this.listProjects();
        let selectedProjectIds: number[] = [];
        let sessionRows: SessionRow[];
        if (scope.sessionIds !== undefined) {
            sessionRows = this.db
                .prepare('SELECT * FROM sessions WHERE id IN (SELECT value FROM json_each(?)) ORDER BY id')
                .all(JSON.stringify(scope.sessionIds))
                .map((row) => hydrateSessionRow(row as Record<string, unknown>));
            selectedProjectIds = scope.projectIds ?? [];
        } else if (scope.projectRoot !== undefined) {
            const root = canonicalizeExisting(scope.projectRoot);
            const projectIds = projects.filter((p) => isWithin(root, canonicalizeExisting(p.path))).map((p) => p.id);
            sessionRows = this.sessionsForProjectIds(projectIds);
            selectedProjectIds = projectIds;
        } else if (scope.projectPath !== undefined) {
            const projectIds = this.findProjectsForPurge(scope.projectPath).map((p) => p.id);
            sessionRows = this.sessionsForProjectIds(projectIds);
            selectedProjectIds = projectIds;
        } else if (scope.projectIds !== undefined) {
            sessionRows = this.sessionsForProjectIds(scope.projectIds);
            selectedProjectIds = scope.projectIds;
        } else if (scope.all || scope.newerThan !== undefined || scope.olderThan !== undefined) {
            sessionRows = this.db
                .prepare('SELECT * FROM sessions')
                .all()
                .map((row) => hydrateSessionRow(row as Record<string, unknown>));
            selectedProjectIds = projects.map((project) => project.id);
        } else {
            sessionRows = [];
        }
        const newerThan = scope.newerThan;
        if (newerThan !== undefined) {
            sessionRows = sessionRows.filter((session) => session.last_ingested_at >= newerThan);
        }
        const olderThan = scope.olderThan;
        if (olderThan !== undefined) {
            sessionRows = sessionRows.filter((session) => session.last_ingested_at <= olderThan);
        }
        const projectById = new Map(projects.map((p) => [p.id, p]));
        const standingRules =
            scope.deleteStandingRules === true && newerThan === undefined && olderThan === undefined
                ? this.standingRules.list(selectedProjectIds).map((rule) => ({
                      ...rule,
                      projectPath: projectById.get(rule.project_id)?.path ?? '(unknown project)',
                  }))
                : [];
        const chatRuleScope =
            scope.sessionRuleNativeUnits !== undefined
                ? `EXISTS (SELECT 1 FROM json_each(?) AS unit
                    WHERE json_extract(unit.value, '$.tool') = tool
                      AND json_extract(unit.value, '$.nativeId') = native_session_id)`
                : 'owner_project_id IN (SELECT value FROM json_each(?))';
        const sessionRules =
            scope.deleteStandingRules === true && newerThan === undefined && olderThan === undefined
                ? (
                      this.db
                          .prepare(
                              `SELECT id, ulid, tool, native_session_id, checkout_anchor, owner_project_id, text, created_at
                               FROM session_rules WHERE ${chatRuleScope} ORDER BY id`,
                          )
                          .all(JSON.stringify(scope.sessionRuleNativeUnits ?? selectedProjectIds)) as SessionRuleRow[]
                  ).map((rule) => ({ ...rule, projectPath: projectById.get(rule.owner_project_id)?.path ?? '(unknown project)' }))
                : [];
        const countTurns = this.db.prepare('SELECT COUNT(*) as c FROM memories WHERE session_id = ?');
        const filteredRows = this.db.prepare(
            `SELECT ft.memory_id,
                    length(CAST(ft.user_prompt AS BLOB))
                      + length(CAST(ft.assistant_response AS BLOB))
                      + COALESCE(length(CAST(ft.assistant_structure AS BLOB)), 0)
                      + length(CAST(ft.tool_calls AS BLOB)) AS bytes
             FROM filtered_turns ft
             JOIN memories m ON m.id = ft.memory_id
             WHERE m.session_id = ?
             ORDER BY m.turn_index`,
        );
        const stagedFiltered = this.db.prepare(
            `SELECT CASE WHEN durable_included IS NULL THEN 0 ELSE 1 END AS count,
                    COALESCE(length(CAST(durable_user_prompt AS BLOB)), 0)
                      + COALESCE(length(CAST(durable_assistant_response AS BLOB)), 0)
                      + COALESCE(length(CAST(durable_assistant_structure AS BLOB)), 0)
                      + COALESCE(length(CAST(durable_tool_calls AS BLOB)), 0) AS bytes
             FROM open_turns WHERE session_id = ?`,
        );
        const sessions: PurgeSessionPreview[] = sessionRows.map((s) => {
            const filtered = filteredRows.all(s.id) as Array<{ memory_id: number; bytes: number }>;
            const staged = stagedFiltered.get(s.id) as { count: number; bytes: number } | undefined;
            return {
                id: s.id,
                segmentIndex: s.segment_index,
                nativeId: s.native_id,
                title: s.title,
                projectId: s.project_id,
                projectPath: projectById.get(s.project_id)?.path ?? '(unknown project)',
                tool: s.tool,
                startedAt: s.started_at,
                lastIngestedAt: s.last_ingested_at,
                turnCount: (countTurns.get(s.id) as { c: number }).c,
                filteredTurnCount: filtered.length + (staged?.count ?? 0),
                filteredBytes: filtered.reduce((sum, row) => sum + row.bytes, staged?.bytes ?? 0),
                filteredMemoryIds: filtered.map((row) => row.memory_id),
            };
        });
        // Compare both kinds of retained ownership, including rule-only projects.
        const purgedByProject = new Map<number, number>();
        for (const s of sessions) {
            purgedByProject.set(s.projectId, (purgedByProject.get(s.projectId) ?? 0) + 1);
        }
        for (const rule of standingRules) {
            if (!purgedByProject.has(rule.project_id)) {
                purgedByProject.set(rule.project_id, 0);
            }
        }
        for (const rule of sessionRules) {
            if (!purgedByProject.has(rule.owner_project_id)) {
                purgedByProject.set(rule.owner_project_id, 0);
            }
        }
        const totalSessionsByProject = this.db.prepare('SELECT COUNT(*) as c FROM sessions WHERE project_id = ?');
        const totalSessionRulesByProject = this.db.prepare('SELECT COUNT(*) as c FROM session_rules WHERE owner_project_id = ?');
        const emptiedProjects: ProjectRow[] = [];
        for (const [projectId, purgedCount] of purgedByProject) {
            const total = (totalSessionsByProject.get(projectId) as { c: number }).c;
            const retainedRules =
                this.standingRules.list([projectId]).length - standingRules.filter((rule) => rule.project_id === projectId).length;
            const retainedSessionRules =
                (totalSessionRulesByProject.get(projectId) as { c: number }).c -
                sessionRules.filter((rule) => rule.owner_project_id === projectId).length;
            if (purgedCount === total && retainedRules === 0 && retainedSessionRules === 0) {
                const project = projectById.get(projectId);
                if (project) {
                    emptiedProjects.push(project);
                }
            }
        }
        return { scope, sessions, standingRules, sessionRules, emptiedProjects };
    }

    // Applies exactly the still-present sessions and unchanged rules in a previewed plan, in one transaction.
    applyPurgePlan(plan: PurgePlan, purgedAt = new Date().toISOString()): PurgePlan {
        assertOrphanPlanFilesystem(this, plan);
        const sessionIdentity = this.db.prepare('SELECT tool, native_id FROM sessions WHERE id = ?');
        const tombstone = this.db.prepare('INSERT OR IGNORE INTO purged_transcripts (tool, native_id, purged_at) VALUES (?, ?, ?)');
        const deleteRollup = this.db.prepare('DELETE FROM session_rollups WHERE session_id = ?');
        const deleteFilteredTurns = this.db.prepare(
            'DELETE FROM filtered_turns WHERE memory_id IN (SELECT id FROM memories WHERE session_id = ?)',
        );
        const deleteDurableCaptureStatus = this.db.prepare('DELETE FROM durable_capture_status WHERE session_id = ?');
        const deleteMcpReceipts = this.db.prepare('DELETE FROM mcp_receipts WHERE tool = ? AND native_session_id = ?');
        const deleteSourceGeneration = this.db.prepare('DELETE FROM source_generations WHERE tool = ? AND native_id = ?');
        const deleteMemories = this.db.prepare('DELETE FROM memories WHERE session_id = ?');
        const deleteSession = this.db.prepare('DELETE FROM sessions WHERE id = ?');
        const countProjectSessions = this.db.prepare('SELECT COUNT(*) AS count FROM sessions WHERE project_id = ?');
        const countProjectRules = this.db.prepare('SELECT COUNT(*) AS count FROM standing_rules WHERE project_id = ?');
        const countSessionRules = this.db.prepare('SELECT COUNT(*) AS count FROM session_rules WHERE owner_project_id = ?');
        const ruleIdentity = this.db.prepare('SELECT id, ulid, project_id, text, created_at FROM standing_rules WHERE id = ?');
        const deleteRule = this.db.prepare(
            'DELETE FROM standing_rules WHERE id = ? AND ulid = ? AND project_id = ? AND text = ? AND created_at = ?',
        );
        const chatRuleIdentity = this.db.prepare(
            'SELECT id, ulid, tool, native_session_id, checkout_anchor, owner_project_id, text, created_at FROM session_rules WHERE id = ?',
        );
        const deleteChatRule = this.db.prepare(
            `DELETE FROM session_rules
             WHERE id = ? AND ulid = ? AND tool = ? AND native_session_id = ? AND checkout_anchor = ?
               AND owner_project_id = ? AND text = ? AND created_at = ?`,
        );
        const deleteProject = this.db.prepare('DELETE FROM projects WHERE id = ?');
        const appliedSessions: PurgeSessionPreview[] = [];
        const emptiedProjects: ProjectRow[] = [];

        const write = () => {
            assertOrphanPlanDatabase(this, plan);

            for (const planned of plan.standingRules) {
                const current = ruleIdentity.get(planned.id) as StandingRuleRow | undefined;
                const project = this.getProjectById(planned.project_id);
                if (
                    current === undefined ||
                    current.ulid !== planned.ulid ||
                    current.project_id !== planned.project_id ||
                    current.text !== planned.text ||
                    current.created_at !== planned.created_at ||
                    project?.path !== planned.projectPath
                ) {
                    throw new Error(`Purge plan standing rule ${planned.ulid} (id ${planned.id}) no longer matches the previewed rule.`);
                }
            }
            for (const planned of plan.sessionRules) {
                const current = chatRuleIdentity.get(planned.id) as SessionRuleRow | undefined;
                const project = this.getProjectById(planned.owner_project_id);
                if (
                    current === undefined ||
                    current.ulid !== planned.ulid ||
                    current.tool !== planned.tool ||
                    current.native_session_id !== planned.native_session_id ||
                    current.checkout_anchor !== planned.checkout_anchor ||
                    current.owner_project_id !== planned.owner_project_id ||
                    current.text !== planned.text ||
                    current.created_at !== planned.created_at ||
                    project?.path !== planned.projectPath
                ) {
                    throw new Error(`Purge plan chat rule ${planned.ulid} (id ${planned.id}) no longer matches the previewed rule.`);
                }
            }
            for (const planned of plan.emptiedProjects) {
                const current = this.getProjectById(planned.id);
                if (
                    current !== undefined &&
                    (plan.orphanEvidence
                        ? projectAssociationIdentity(current) !== projectAssociationIdentity(planned)
                        : Object.keys(planned).some((key) => current[key as keyof ProjectRow] !== planned[key as keyof ProjectRow]))
                ) {
                    throw new Error(`Purge plan project id ${planned.id} no longer matches the previewed project.`);
                }
            }
            for (const s of plan.sessions) {
                const identity = sessionIdentity.get(s.id) as { tool: string; native_id: string } | undefined;
                if (!identity) {
                    continue;
                }
                if (identity.tool !== s.tool || identity.native_id !== s.nativeId) {
                    throw new Error(`Purge plan session id ${s.id} no longer matches the previewed session.`);
                }
                tombstone.run(identity.tool, identity.native_id, purgedAt);
                deleteMcpReceipts.run(identity.tool, identity.native_id);
                deleteSourceGeneration.run(identity.tool, identity.native_id);
                if (plan.orphanEvidence) {
                    for (const table of ['injections', 'shown_session_lists']) {
                        this.db
                            .prepare(`DELETE FROM ${table} WHERE tool = ? AND native_session_id = ?`)
                            .run(identity.tool, identity.native_id);
                    }
                    this.db
                        .prepare('DELETE FROM live_memory_capture_deferrals WHERE tool = ? AND native_id = ?')
                        .run(identity.tool, identity.native_id);
                    if (this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'segment_corrections'").get()) {
                        this.db
                            .prepare('DELETE FROM segment_corrections WHERE tool = ? AND native_id = ?')
                            .run(identity.tool, identity.native_id);
                    }
                }
                deleteRollup.run(s.id);
                deleteFilteredTurns.run(s.id);
                deleteDurableCaptureStatus.run(s.id);
                deleteMemories.run(s.id);
                deleteSession.run(s.id);
                appliedSessions.push(s);
            }
            for (const rule of plan.standingRules) {
                if (deleteRule.run(rule.id, rule.ulid, rule.project_id, rule.text, rule.created_at).changes !== 1) {
                    throw new Error(`Purge plan standing rule ${rule.ulid} could not be deleted as previewed.`);
                }
            }
            for (const rule of plan.sessionRules) {
                if (
                    deleteChatRule.run(
                        rule.id,
                        rule.ulid,
                        rule.tool,
                        rule.native_session_id,
                        rule.checkout_anchor,
                        rule.owner_project_id,
                        rule.text,
                        rule.created_at,
                    ).changes !== 1
                ) {
                    throw new Error(`Purge plan chat rule ${rule.ulid} could not be deleted as previewed.`);
                }
            }
            for (const p of plan.emptiedProjects) {
                const remaining = countProjectSessions.get(p.id) as { count: number };
                const retainedRules = countProjectRules.get(p.id) as { count: number };
                const retainedChatRules = countSessionRules.get(p.id) as { count: number };
                if (
                    remaining.count === 0 &&
                    retainedRules.count === 0 &&
                    retainedChatRules.count === 0 &&
                    deleteProject.run(p.id).changes > 0
                ) {
                    emptiedProjects.push(p);
                }
            }
            if (plan.orphanEvidence) {
                verifyOrphanPurge(this, plan);
            }
        };
        this.db.transaction(write)();
        // "Revocation = deletion" isn't true of the file on disk until the
        // WAL is reclaimed too - a deleted row's page can sit in
        // elepha.db-wal, readable to anything with filesystem access, until a
        // checkpoint overwrites it. TRUNCATE both checkpoints and shrinks the
        // file back to zero, rather than leaving a large reusable-but-still-
        // populated WAL behind.
        this.db.pragma('wal_checkpoint(TRUNCATE)');
        return { ...plan, sessions: appliedSessions, emptiedProjects };
    }

    // Plans and applies a scope immediately. Existing callers retain the same behavior and signature.
    purge(scope: PurgeScope, purgedAt = new Date().toISOString()): PurgePlan {
        return this.applyPurgePlan(this.planPurge(scope), purgedAt);
    }

    listMemoriesForSession(sessionId: number): MemoryRow[] {
        return this.turns.listMemoriesForSession(sessionId);
    }

    listRecentMemories(projectId: number, limit = 20): MemoryRow[] {
        return this.turns.listRecentMemories(projectId, limit);
    }

    // Local diagnostics only; never part of served memory.
    getStats(sinceIso: string): Stats {
        const byTool = this.db
            .prepare(`SELECT tool, COUNT(DISTINCT session_id) as sessions, COUNT(*) as turns
         FROM memories WHERE turn_started_at >= ? GROUP BY tool`)
            .all(sinceIso) as ToolCount[];
        const perSessionCounts = (
            this.db.prepare(`SELECT COUNT(*) as cnt FROM memories WHERE turn_started_at >= ? GROUP BY session_id`).all(sinceIso) as Array<{
                cnt: number;
            }>
        ).map((r) => r.cnt);
        const perSessionPending = (
            this.db
                .prepare(`SELECT SUM(json_array_length(pending_items)) as cnt FROM memories WHERE turn_started_at >= ? GROUP BY session_id`)
                .all(sinceIso) as Array<{ cnt: number }>
        ).map((r) => r.cnt);
        const byProject = this.db
            .prepare(
                `SELECT m.project_id as project_id, COALESCE(p.display_name, p.path) as project,
                COUNT(*) as memories, SUM(json_array_length(m.pending_items)) as open_pending_items
         FROM memories m JOIN projects p ON p.id = m.project_id
         WHERE m.turn_started_at >= ?
         GROUP BY m.project_id
         ORDER BY memories DESC`,
            )
            .all(sinceIso) as ProjectCount[];
        const noise = this.db
            .prepare(
                `SELECT
           SUM(CASE WHEN decisions = '[]' AND pending_items = '[]' THEN 1 ELSE 0 END) as count,
           COUNT(*) as total
         FROM memories WHERE turn_started_at >= ?`,
            )
            .get(sinceIso) as { count: number; total: number };
        const filesTouchedZero = this.db
            .prepare(
                `SELECT tool,
           SUM(CASE WHEN files_touched = '[]' THEN 1 ELSE 0 END) as zero_paths,
           COUNT(*) as total
         FROM memories WHERE turn_started_at >= ? GROUP BY tool`,
            )
            .all(sinceIso) as ToolZeroPaths[];
        const byStatus = this.db
            .prepare(`SELECT summarizer_status, COUNT(*) as count FROM memories WHERE turn_started_at >= ? GROUP BY summarizer_status`)
            .all(sinceIso) as StatusCount[];
        return {
            since: sinceIso,
            totalMemories: noise.total,
            byTool,
            memoriesPerSession: minMedianMax(perSessionCounts),
            pendingItemsPerSession: minMedianMax(perSessionPending),
            byProject,
            noise,
            byStatus,
            filesTouchedZero,
        };
    }

    private sessionsForProjectIds(projectIds: number[]): SessionRow[] {
        return projectIds.length === 0
            ? []
            : this.db
                  .prepare(`SELECT * FROM sessions WHERE project_id IN (${projectIds.map(() => '?').join(',')})`)
                  .all(...projectIds)
                  .map((row) => hydrateSessionRow(row as Record<string, unknown>));
    }
}
