// Recover pending task-state reports from authenticated retained evidence.
// Publication consumes its hook request only when the reporting turn still matches.

import { statSync } from 'node:fs';
import { stat as fsStat } from 'node:fs/promises';
import { TranscriptReadBudgetError } from '../adapters/base.js';
import { sessionAdapterFor } from '../adapters/index.js';
import { DURABLE_CAPTURE_FILTER_VERSION } from '../config/constants.js';
import { canonicalizeExisting, samePath } from '../config/paths.js';
import { getSetting } from '../config/settings.js';
import {
    TASK_STATE_MANIFEST_RECOVERY_BATCH,
    TASK_STATE_MANIFEST_RECOVERY_PASS_BYTES,
    TASK_STATE_MANIFEST_RECOVERY_PASS_MS,
} from '../config/task-state-manifest-recovery.js';
import {
    type OpenedProviderTranscript,
    type ProviderTranscriptOpener,
    validateOpenedProviderTranscriptIdentitySync,
} from '../security/provider-transcript.js';
import { manifestSourcesStillCurrent, verifyTaskStateManifest } from '../serving/task-state-manifest-verifier.js';
import { NOT_CURRENT_COPY_SQL } from '../storage/durable-capture-store.js';
import type { MemoryStore } from '../storage/memory-store.js';
import { SERVED_SESSION_KIND_ELIGIBILITY } from '../storage/session-read-model.js';

import { decodeResumeContext } from '../storage/source-resume-context.js';
import { sourceTurnDigest } from '../storage/source-turn-digest.js';
import { TaskStateManifestStore } from '../storage/task-state-manifest-store.js';
import { TaskStateRequestStore } from '../storage/task-state-request-store.js';
import { TURN_SEARCH_INDEX_TABLE } from '../storage/turn-search-index.js';
import type { ParsedTurn, ResumeContext, SessionAdapter, SessionAdapterMap, SourceReadBudget, ToolName } from '../types/index.js';

export interface TaskStateManifestRecoveryBudget {
    requests: number;
    bytes: number;
    elapsedMs: number;
}

export interface TaskStateManifestPublisherOptions {
    store: MemoryStore;
    adapters: SessionAdapterMap;
    openTranscript: ProviderTranscriptOpener;
    log: (message: string) => void;
    logError: (message: string) => void;
    // Runs recovery on the daemon's work queue rather than inline.
    enqueue: (job: () => Promise<void>) => void;
    // A stopping daemon starts no further pass.
    stopped: () => boolean;
    budget?: Partial<TaskStateManifestRecoveryBudget>;
}

interface PendingRequest {
    request_id: string;
    tool: ToolName;
    native_session_id: string;
    source_path: string;
    after_turn_index: number;
    issued_at: string;
}

// Where a source read begins: byte zero, or an authenticated cursor with the
// resume context the adapter issued for it. The parse re-reads and verifies
// that context against the opened source before resuming.
interface ReadStart {
    cursor: string | undefined;
    context: ResumeContext | undefined;
}

const SOURCE_START: ReadStart = { cursor: undefined, context: undefined };

// The opened source a recovered reporting turn was read from, where that read
// began, and how many bytes it consumed; replaying it costs no more.
interface ReportingSource {
    adapter: SessionAdapter;
    opened: OpenedProviderTranscript;
    start: ReadStart;
    readBytes: number;
    pass: RecoveryPass;
}

interface RecoveryPass {
    // Every source read of the pass is charged here, including cursor and
    // context authentication and the final re-read.
    budget: SourceReadBudget;
    readonly deadline: number;
    // Nothing read yet: a request that cannot progress with a whole pass
    // budget never will.
    untouched: boolean;
}

function cursorOffset(adapter: SessionAdapter, cursor: string | undefined): number | undefined {
    return cursor === undefined ? 0 : adapter.cursorPosition?.(cursor).byteOffset;
}

// Containment only: the re-read source must still be the same contained file
// and may only have grown. Content integrity of the reporting turn comes from
// re-reading it against retained coverage, never from identity or size.
function appendOnlySourceValidator(tool: ToolName, filePath: string, opened: OpenedProviderTranscript): () => boolean {
    return () => {
        if ('reason' in validateOpenedProviderTranscriptIdentitySync(tool, filePath, opened)) {
            return false;
        }
        try {
            const current = statSync(filePath);
            return current.dev === opened.stat.dev && current.ino === opened.stat.ino && current.size >= opened.stat.size;
        } catch {
            return false;
        }
    };
}

export class TaskStateManifestPublisher {
    private readonly budget: TaskStateManifestRecoveryBudget;
    // Where an unfinished source read resumes, per request.
    private readonly continuations = new Map<string, ReadStart>();
    // The last request a general sweep finished; undefined starts a new sweep.
    private sweepAfter: { issuedAt: string; requestId: string } | undefined;

    constructor(private readonly options: TaskStateManifestPublisherOptions) {
        this.budget = {
            requests: options.budget?.requests ?? TASK_STATE_MANIFEST_RECOVERY_BATCH,
            bytes: options.budget?.bytes ?? TASK_STATE_MANIFEST_RECOVERY_PASS_BYTES,
            elapsedMs: options.budget?.elapsedMs ?? TASK_STATE_MANIFEST_RECOVERY_PASS_MS,
        };
    }

    // Publishes the manifest a just-captured or freshly re-read reporting turn
    // carries. `turn.validateSource` must describe the still-open source; a
    // recovered turn also names that source so it is re-read after verification.
    async publish(turn: ParsedTurn, sessionDbId: number, source?: ReportingSource): Promise<void> {
        if (turn.taskStateReport?.mode !== 'precompact_manifest') {
            return;
        }
        const { store } = this.options;
        const db = store.database;
        const unavailable = (reason: string): void => {
            this.options.logError(
                `[elepha] task-state manifest unavailable for turn ${turn.turnIndex}: ${reason} tool=${turn.tool} session_id=${turn.sessionId}`,
            );
        };
        const requestId = turn.taskStateReport.request_id;
        // A live scan of an append-only transcript carries no source validator
        // for its turns. Its manifest is published by re-reading the turn
        // instead of trusting the in-flight parse.
        if (turn.validateSource === undefined) {
            this.options.enqueue(() => this.recover(requestId));
            return;
        }
        try {
            if (!getSetting('memory-plus').value) {
                unavailable('Memory-Plus disabled');
                return;
            }
            const memory = db.prepare('SELECT id FROM memories WHERE session_id = ? AND turn_index = ?').get(sessionDbId, turn.turnIndex) as
                | { id: number }
                | undefined;
            if (memory === undefined) {
                unavailable('reporting memory missing');
                return;
            }
            const requests = new TaskStateRequestStore(db);
            const requestScope = {
                requestId,
                mode: turn.taskStateReport.mode,
                tool: turn.tool,
                nativeSessionId: turn.sessionId,
                sessionId: sessionDbId,
                cwd: turn.projectPath,
                sourcePath: turn.sourcePath,
                turnIndex: turn.turnIndex,
            };
            if (!requests.canConsume(requestScope)) {
                unavailable('no matching unconsumed hook request');
                return;
            }
            if (!this.reportingTurnCovered(turn)) {
                unavailable('reporting turn does not match its retained coverage');
                return;
            }
            const { callId: _callId, ...report } = turn.taskStateReport;
            const prepared = await verifyTaskStateManifest(db, { reportingMemoryId: memory.id, report, cwd: turn.projectPath });
            if (prepared.state !== 'prepared') {
                unavailable(prepared.reason);
                return;
            }
            if (prepared.manifest.coverage.state !== 'verified') {
                unavailable(`source coverage incomplete: ${prepared.manifest.coverage.reason}`);
                return;
            }
            // Complete physical and opened-source checks before taking SQLite's write lock.
            const physicalCheckout = canonicalizeExisting(turn.projectPath);
            const physicalStat = await fsStat(physicalCheckout).catch(() => undefined);
            if (!physicalStat?.isDirectory()) {
                unavailable('reporting checkout missing');
                return;
            }
            if (store.consent.isRefusedForCapture(turn.projectPath)) {
                unavailable('reporting checkout refused');
                return;
            }
            for (const row of prepared.checkpoint.rows) {
                const sourceCheckout = canonicalizeExisting(row.projectPath);
                const sourceStat = await fsStat(sourceCheckout).catch(() => undefined);
                if (
                    !sourceStat?.isDirectory() ||
                    !samePath(sourceCheckout, physicalCheckout) ||
                    store.consent.isRefusedForCapture(row.projectPath)
                ) {
                    unavailable('source checkout changed');
                    return;
                }
            }
            // Last awaited step before the write transaction: the reporting
            // turn's own bytes still parse to its retained coverage.
            if ((source !== undefined && !(await this.reportingSourceCurrent(turn, source))) || turn.validateSource?.() !== true) {
                unavailable('reporting source changed');
                return;
            }
            const memoryPlusEnabled = getSetting('memory-plus').value;
            const manifests = new TaskStateManifestStore(db);
            // Every decisive database fact is repeated inside the request's
            // consumption transaction, including the reporting-turn coverage.
            const outcome = requests.consumeForVerifiedManifest(requestScope, () => {
                if (
                    !memoryPlusEnabled ||
                    store.consent.consentStateForCanonicalPath(physicalCheckout) !== 'approved' ||
                    store.isTranscriptCaptureBlocked(turn.tool, turn.sessionId) ||
                    store.isTranscriptIncognito(turn.tool, turn.sessionId) ||
                    !this.reportingTurnCovered(turn) ||
                    !manifestSourcesStillCurrent(db, prepared.manifest, prepared.checkpoint)
                ) {
                    return false;
                }
                return manifests.insert(prepared.manifest) === 'inserted';
            });
            if (!outcome) {
                unavailable('request, authorization, or source identity changed');
            }
        } catch (error) {
            unavailable((error as Error).message);
        }
    }

    // One bounded recovery pass. Without a request id it continues the
    // general sweep of unconsumed precompact requests whose session already
    // stores a later turn without a manifest; with one, only that request.
    // Unfinished work is queued as a later pass, never reported as done.
    async recover(requestId?: string): Promise<void> {
        if (this.options.stopped()) {
            return;
        }
        const pass: RecoveryPass = {
            budget: { remaining: this.budget.bytes },
            deadline: Date.now() + this.budget.elapsedMs,
            untouched: true,
        };
        if (requestId !== undefined) {
            const [request] = this.pending(requestId, undefined, 1);
            if (request === undefined) {
                this.continuations.delete(requestId);
                return;
            }
            if ((await this.recoverRequest(request, pass)) === 'exhausted') {
                this.options.enqueue(() => this.recover(requestId));
            }
            return;
        }
        const batch = this.pending(undefined, this.sweepAfter, this.budget.requests);
        for (const request of batch) {
            if (this.options.stopped()) {
                return;
            }
            // The sweep position stays on this request, so the next pass
            // resumes it rather than skipping it.
            const spent = !pass.untouched && (pass.budget.remaining <= 0 || Date.now() >= pass.deadline);
            if (spent || (await this.recoverRequest(request, pass)) === 'exhausted') {
                this.options.enqueue(() => this.recover());
                return;
            }
            this.sweepAfter = { issuedAt: request.issued_at, requestId: request.request_id };
        }
        if (batch.length < this.budget.requests) {
            this.sweepAfter = undefined;
            return;
        }
        this.options.enqueue(() => this.recover());
    }

    private pending(
        requestId: string | undefined,
        after: { issuedAt: string; requestId: string } | undefined,
        limit: number,
    ): PendingRequest[] {
        return this.options.store.database
            .prepare(
                `SELECT r.request_id, r.tool, r.native_session_id, r.source_path, r.after_turn_index, r.issued_at
                 FROM task_state_requests r
                 WHERE r.consumed_at IS NULL AND r.mode = 'precompact_manifest' AND r.tool IN ('claude-code', 'codex')
                   AND (? IS NULL OR r.request_id = ?)
                   AND (? IS NULL OR r.issued_at > ? OR (r.issued_at = ? AND r.request_id > ?))
                   AND EXISTS (SELECT 1 FROM memories m JOIN sessions s ON s.id = m.session_id
                       WHERE s.tool = r.tool AND s.native_id = r.native_session_id AND m.turn_index > r.after_turn_index
                         AND NOT EXISTS (SELECT 1 FROM task_state_manifests t WHERE t.memory_id = m.id))
                 ORDER BY r.issued_at, r.request_id
                 LIMIT ?`,
            )
            .all(
                requestId ?? null,
                requestId ?? null,
                after?.issuedAt ?? null,
                after?.issuedAt ?? null,
                after?.issuedAt ?? null,
                after?.requestId ?? null,
                limit,
            ) as PendingRequest[];
    }

    private async recoverRequest(request: PendingRequest, pass: RecoveryPass): Promise<'done' | 'exhausted'> {
        const adapter = sessionAdapterFor(this.options.adapters, request.tool);
        if (adapter === undefined) {
            return 'done';
        }
        const context = `tool=${request.tool} session_id=${request.native_session_id}`;
        const opened = await this.options.openTranscript(request.tool, request.source_path);
        if ('reason' in opened) {
            this.continuations.delete(request.request_id);
            this.options.logError(`[elepha] task-state manifest recovery could not open its source (${opened.reason}) ${context}`);
            return 'done';
        }
        try {
            const validateSource = appendOnlySourceValidator(request.tool, request.source_path, opened);
            const untouched = pass.untouched;
            pass.untouched = false;
            let resumeAt: ReadStart = SOURCE_START;
            let start: ReadStart = SOURCE_START;
            let outOfBytes = false;
            let outOfTime = false;
            let reporting: ParsedTurn | undefined;
            let readBytes = 0;
            let desynced = false;
            try {
                start = this.readStart(request, adapter);
                resumeAt = start;
                const before = pass.budget.remaining;
                try {
                    for await (const turn of adapter.parseTurns(opened.resolvedPath, start.cursor, {
                        closeTrailingOnIdle: true,
                        handle: opened.handle,
                        resumeContext: start.context,
                        readBudget: pass.budget,
                        onDesync: () => {
                            desynced = true;
                        },
                    })) {
                        if (
                            turn.turnIndex > request.after_turn_index &&
                            turn.taskStateReport?.mode === 'precompact_manifest' &&
                            turn.taskStateReport.request_id === request.request_id
                        ) {
                            reporting = turn;
                            break;
                        }
                        // A turn without a source-read context cannot be
                        // resumed from by an adapter that needs one.
                        if (turn.resumeContext !== undefined || !adapter.carriesContextAcrossTurns) {
                            resumeAt = { cursor: turn.cursor, context: turn.resumeContext };
                        }
                        // Time is checked between turns, so every pass progresses.
                        if (resumeAt !== start && Date.now() >= pass.deadline) {
                            outOfTime = true;
                            break;
                        }
                    }
                } finally {
                    readBytes = before - pass.budget.remaining;
                }
            } catch (error) {
                if (!(error instanceof TranscriptReadBudgetError)) {
                    throw error;
                }
                outOfBytes = true;
                pass.budget.remaining = 0;
            }
            if (desynced) {
                // The cursor or its context no longer matches the source; the
                // next pass reads from the start, where both come from the source.
                this.continuations.set(request.request_id, SOURCE_START);
                return 'exhausted';
            }
            if (outOfBytes || outOfTime) {
                if (outOfBytes && resumeAt === start && untouched) {
                    this.continuations.delete(request.request_id);
                    this.options.logError(
                        `[elepha] task-state manifest recovery: a turn exceeds one pass budget; request left pending ${context}`,
                    );
                    return 'done';
                }
                if (resumeAt.cursor !== undefined) {
                    this.continuations.set(request.request_id, resumeAt);
                }
                this.options.log(`[elepha] task-state manifest recovery paused at its pass budget; resuming in a later pass ${context}`);
                return 'exhausted';
            }
            this.continuations.delete(request.request_id);
            if (reporting === undefined || reporting.tool !== request.tool || reporting.sessionId !== request.native_session_id) {
                // The request stays unconsumed; a later complete report may still arrive.
                this.options.log(`[elepha] task-state manifest recovery: reporting turn not found in its source ${context}`);
                return 'done';
            }
            const session = this.options.store.database
                .prepare(`SELECT m.session_id FROM memories m JOIN sessions s ON s.id = m.session_id
                    WHERE s.tool = ? AND s.native_id = ? AND m.turn_index = ?`)
                .pluck()
                .get(request.tool, request.native_session_id, reporting.turnIndex) as number | undefined;
            if (session === undefined) {
                // Not captured yet: live capture publishes it.
                return 'done';
            }
            reporting.validateSource = validateSource;
            await this.publish(reporting, session, { adapter, opened, start, readBytes, pass });
            return 'done';
        } finally {
            await opened.handle.close();
        }
    }

    // A read resumes from this request's continuation, else from the last
    // retained turn at or before the request. The parse authenticates the
    // cursor and its resume context against the opened source, charging the
    // pass, and a refusal sends the next pass to byte zero. An adapter whose
    // turns depend on earlier records cannot resume at a retained cursor
    // recorded without a complete context; that read starts at byte zero,
    // where the context comes from the source itself.
    private readStart(request: PendingRequest, adapter: SessionAdapter): ReadStart {
        const continuation = this.continuations.get(request.request_id);
        if (continuation !== undefined) {
            return continuation;
        }
        const retained = this.options.store.database
            .prepare(`SELECT m.turn_index, tsi.source_cursor, tsi.source_context FROM memories m
                JOIN sessions s ON s.id = m.session_id
                JOIN ${TURN_SEARCH_INDEX_TABLE} tsi ON tsi.memory_id = m.id
                WHERE s.tool = ? AND s.native_id = ? AND m.turn_index <= ? AND tsi.source_cursor IS NOT NULL
                ORDER BY m.turn_index DESC LIMIT 1`)
            .get(request.tool, request.native_session_id, request.after_turn_index) as
            | { turn_index: number; source_cursor: string; source_context: string | null }
            | undefined;
        if (retained === undefined || adapter.cursorPosition?.(retained.source_cursor).nextTurnIndex !== retained.turn_index + 1) {
            return SOURCE_START;
        }
        const context = decodeResumeContext(retained.source_context);
        if (adapter.carriesContextAcrossTurns && (context === undefined || adapter.resumeContextComplete?.(context) !== true)) {
            return SOURCE_START;
        }
        return { cursor: retained.source_cursor, context };
    }

    // Replays the read that found the reporting turn, from its authenticated
    // start and context through the turn's end and no further, within the
    // bytes that read consumed; the replay is charged to the pass too. The
    // turn must still parse to the same index, report and end cursor, and
    // match the digest its retained coverage pinned.
    private async reportingSourceCurrent(turn: ParsedTurn, source: ReportingSource): Promise<boolean> {
        const start = cursorOffset(source.adapter, source.start.cursor);
        const end = cursorOffset(source.adapter, turn.cursor);
        if (start === undefined || end === undefined || end <= start) {
            return false;
        }
        const replay: SourceReadBudget = { remaining: source.readBytes };
        try {
            for await (const fresh of source.adapter.parseTurns(source.opened.resolvedPath, source.start.cursor, {
                closeTrailingOnIdle: true,
                handle: source.opened.handle,
                // Re-verifies the start's context records against the source too.
                resumeContext: source.start.context,
                endByteOffset: end,
                readBudget: replay,
            })) {
                if (fresh.turnIndex === turn.turnIndex) {
                    return (
                        fresh.cursor === turn.cursor &&
                        fresh.taskStateReport?.request_id === turn.taskStateReport?.request_id &&
                        this.reportingTurnCovered(fresh)
                    );
                }
            }
            return false;
        } finally {
            source.pass.budget.remaining = Math.max(0, source.pass.budget.remaining - (source.readBytes - replay.remaining));
        }
    }

    // The coverage row pins the digest of the exact source turn retained at
    // capture, report included. Claude Code and Codex turns carry no stable
    // source key, so this is the only content proof for a re-read turn.
    private reportingTurnCovered(turn: ParsedTurn): boolean {
        const rows = this.options.store.database
            .prepare(`SELECT m.project_id = s.project_id AND ${SERVED_SESSION_KIND_ELIGIBILITY}
                AND NOT ${NOT_CURRENT_COPY_SQL} AND tsi.source_digest = ? AND tsi.filter_version = ? AS current
                FROM memories m JOIN sessions s ON s.id = m.session_id
                JOIN projects p ON p.id = m.project_id
                LEFT JOIN filtered_turns ft ON ft.memory_id = m.id
                LEFT JOIN ${TURN_SEARCH_INDEX_TABLE} tsi ON tsi.memory_id = m.id
                WHERE s.tool = ? AND s.native_id = ? AND m.turn_index = ? LIMIT 2`)
            .all(sourceTurnDigest(turn), DURABLE_CAPTURE_FILTER_VERSION, turn.tool, turn.sessionId, turn.turnIndex) as Array<{
            current: number;
        }>;
        return rows.length === 1 && rows[0]?.current === 1;
    }
}
