import type { Stats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import type { Database, Statement } from 'better-sqlite3-multiple-ciphers';
import {
    DURABLE_CAPTURE_FILTER_VERSION,
    DURABLE_CAPTURE_MAX_BYTES,
    type DurableCaptureState,
    SESSION_CHAR_BUDGET,
} from '../config/constants.js';
import type { FilterableToolCall, FilteredTurnProjection } from '../rendering/filtered-turn.js';
import {
    openProviderTranscript,
    type ProviderTranscriptIdentitySyncValidator,
    type ProviderTranscriptOpener,
    validateOpenedProviderTranscriptIdentitySync,
} from '../security/provider-transcript.js';
import { detectShellSyntax, escapeShellSyntax } from '../security/sanitize.js';
import type { ToolName } from '../types/index.js';

interface EvictionCandidate {
    id: number;
    tool: ToolName;
    source_path: string;
}

interface FrozenEvictionCandidate extends EvictionCandidate {
    recoverable: boolean;
}

interface FrozenCurrentEvictionCandidate {
    id?: number;
    tool: ToolName;
    source_path: string;
    recoverable: boolean;
}

export interface DurableEvictionCurrentSource {
    sessionId?: number;
    tool: ToolName;
    sourcePath: string;
}

export class DurableEvictionPlan {
    private constructor(
        private readonly candidates: ReadonlyMap<number, FrozenEvictionCandidate>,
        private readonly current: FrozenCurrentEvictionCandidate,
    ) {}

    static from(candidates: ReadonlyMap<number, FrozenEvictionCandidate>, current: FrozenCurrentEvictionCandidate): DurableEvictionPlan {
        return new DurableEvictionPlan(candidates, current);
    }

    isRecoverable(candidate: EvictionCandidate): boolean {
        const frozen = this.candidates.get(candidate.id);
        return frozen?.recoverable === true && frozen.tool === candidate.tool && frozen.source_path === candidate.source_path;
    }

    isCurrentRecoverable(candidate: EvictionCandidate): boolean {
        return (
            this.current.recoverable &&
            (this.current.id === undefined || this.current.id === candidate.id) &&
            this.current.tool === candidate.tool &&
            this.current.source_path === candidate.source_path
        );
    }
}

export interface DurableEvictionValidationDependencies {
    openTranscript?: ProviderTranscriptOpener;
    validateIdentity?: ProviderTranscriptIdentitySyncValidator;
    beforeFinalIdentityCheck?: () => void;
    // Test seam for an external pathname change after the policy linearizes.
    afterFinalIdentityCheck?: () => void;
}

type NonPromise<T> = T extends PromiseLike<unknown> ? never : T;

function runSynchronousAction<T>(
    action: (plan: DurableEvictionPlan | undefined) => NonPromise<T>,
    plan: DurableEvictionPlan | undefined,
): T {
    const result = action(plan);
    if (result && (typeof result === 'object' || typeof result === 'function') && 'then' in result) {
        throw new TypeError('durable eviction transaction action must be synchronous');
    }
    return result as T;
}

// Opens candidate sources before the write transaction, then performs final
// pathname identity checks and the synchronous write without another await.
// Every opened handle remains held until that write commits or rolls back.
export async function withValidatedDurableEvictionSources<T>(
    db: Database,
    projection: FilteredTurnProjection,
    maxBytes: number,
    currentSource: DurableEvictionCurrentSource,
    action: (plan: DurableEvictionPlan | undefined) => NonPromise<T>,
    dependencies: DurableEvictionValidationDependencies = {},
): Promise<T> {
    const usage = db.prepare('SELECT total_bytes FROM durable_capture_usage WHERE id = 1').get() as { total_bytes: number };
    if (usage.total_bytes + storedProjectionBytes(projection) <= maxBytes) {
        return runSynchronousAction(action, undefined);
    }
    const openTranscript = dependencies.openTranscript ?? openProviderTranscript;
    const validateIdentity = dependencies.validateIdentity ?? validateOpenedProviderTranscriptIdentitySync;
    const candidates = db
        .prepare(
            `SELECT DISTINCT s.id, s.tool, s.source_path
             FROM sessions s
             JOIN memories m ON m.session_id = s.id
             JOIN filtered_turns ft ON ft.memory_id = m.id
             ORDER BY s.last_ingested_at, s.id`,
        )
        .all() as EvictionCandidate[];
    const historicalCandidates = candidates.filter((candidate) => candidate.id !== currentSource.sessionId);
    const opened: Array<{ candidate: EvictionCandidate; handle: FileHandle; stat: Stats }> = [];
    const frozen = new Map<number, FrozenEvictionCandidate>();
    const currentCandidate = {
        id: currentSource.sessionId,
        tool: currentSource.tool,
        source_path: currentSource.sourcePath,
    };
    let currentOpened: { handle: FileHandle; stat: Stats } | undefined;
    let frozenCurrent: FrozenCurrentEvictionCandidate = { ...currentCandidate, recoverable: false };

    let value: T | undefined;
    let failed = false;
    let failure: unknown;
    try {
        for (const candidate of historicalCandidates) {
            const result = await openTranscript(candidate.tool, candidate.source_path);
            if ('reason' in result) {
                frozen.set(candidate.id, { ...candidate, recoverable: false });
            } else {
                opened.push({ candidate, handle: result.handle, stat: result.stat });
            }
        }
        const currentResult = await openTranscript(currentCandidate.tool, currentCandidate.source_path);
        if (!('reason' in currentResult)) {
            currentOpened = { handle: currentResult.handle, stat: currentResult.stat };
        }
        dependencies.beforeFinalIdentityCheck?.();
        for (const source of opened) {
            const identity = validateIdentity(source.candidate.tool, source.candidate.source_path, source);
            frozen.set(source.candidate.id, { ...source.candidate, recoverable: !('reason' in identity) });
        }
        if (currentOpened) {
            const identity = validateIdentity(currentCandidate.tool, currentCandidate.source_path, currentOpened);
            frozenCurrent = { ...currentCandidate, recoverable: !('reason' in identity) };
        }
        dependencies.afterFinalIdentityCheck?.();
        value = runSynchronousAction(action, DurableEvictionPlan.from(frozen, frozenCurrent));
    } catch (error) {
        failed = true;
        failure = error;
    }
    const handles = [...opened.map((source) => source.handle), ...(currentOpened ? [currentOpened.handle] : [])];
    const closures = await Promise.allSettled(
        handles.map(async (handle) => {
            await handle.close();
        }),
    );
    if (failed) {
        throw failure;
    }
    const closeFailure = closures.find((result) => result.status === 'rejected');
    if (closeFailure?.status === 'rejected') {
        throw closeFailure.reason;
    }
    return value as T;
}

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

interface StoredProjection {
    userPrompt: string;
    assistantResponse: string;
    toolCalls: FilterableToolCall[];
    omittedBeforeChars: number;
    droppedToolRefCount: number;
}

export type DurableCaptureRecordResult = 'retained' | 'not_retained';

function boundedSanitizedProjection(projection: FilteredTurnProjection): StoredProjection {
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
    const assistantResponse = appendText(projection.assistantResponse);
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

    return {
        userPrompt: entries.includes(userPrompt) ? userPrompt.value : '',
        assistantResponse: entries.includes(assistantResponse) ? assistantResponse.value : '',
        toolCalls: entries.flatMap((entry) => (entry.kind === 'tool' ? [entry.value] : [])),
        omittedBeforeChars,
        droppedToolRefCount,
    };
}

function storedProjectionBytes(projection: FilteredTurnProjection): number {
    const stored = projection.included
        ? boundedSanitizedProjection(projection)
        : { userPrompt: '', assistantResponse: '', toolCalls: [], omittedBeforeChars: 0, droppedToolRefCount: 0 };
    return (
        Buffer.byteLength(stored.userPrompt) +
        Buffer.byteLength(stored.assistantResponse) +
        Buffer.byteLength(JSON.stringify(stored.toolCalls))
    );
}

export class DurableCaptureStore {
    private readonly insertFilteredTurn: Statement;
    private readonly sessionCaptureState: Statement;
    private readonly upsertStatus: Statement;
    private readonly statusForSession: Statement;
    private readonly totalBytes: Statement;
    private readonly evictionCandidates: Statement;
    private readonly deleteSessionTurns: Statement;

    constructor(db: Database) {
        this.insertFilteredTurn = db.prepare(
            `INSERT INTO filtered_turns
             (memory_id, included, user_prompt, assistant_response, tool_calls, omitted_tool_call_count,
              dropped_tool_ref_count, omitted_before_chars, filter_version, captured_at)
             VALUES (@memory_id, @included, @user_prompt, @assistant_response, @tool_calls, @omitted_tool_call_count,
                     @dropped_tool_ref_count, @omitted_before_chars, @filter_version, @captured_at)`,
        );
        this.sessionCaptureState = db.prepare(
            `SELECT CASE
                WHEN EXISTS (
                    SELECT 1 FROM memories m
                    LEFT JOIN filtered_turns ft ON ft.memory_id = m.id
                    WHERE m.session_id = ? AND ft.memory_id IS NULL
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
        this.totalBytes = db.prepare('SELECT total_bytes FROM durable_capture_usage WHERE id = 1');
        this.evictionCandidates = db.prepare(
            `SELECT DISTINCT s.id, s.tool, s.source_path
             FROM sessions s
             JOIN memories m ON m.session_id = s.id
             JOIN filtered_turns ft ON ft.memory_id = m.id
             ORDER BY s.last_ingested_at, s.id`,
        );
        this.deleteSessionTurns = db.prepare(
            'DELETE FROM filtered_turns WHERE memory_id IN (SELECT id FROM memories WHERE session_id = ?)',
        );
    }

    record(
        memoryId: number | bigint,
        sessionId: number,
        projection: FilteredTurnProjection,
        capturedAt: string,
        maxBytes = DURABLE_CAPTURE_MAX_BYTES,
        evictionPlan?: DurableEvictionPlan,
    ): DurableCaptureRecordResult {
        const status = this.statusForSession.get(sessionId) as { state: DurableCaptureState } | undefined;
        if (status?.state === 'evicted') {
            return 'not_retained';
        }
        const stored = projection.included
            ? boundedSanitizedProjection(projection)
            : { userPrompt: '', assistantResponse: '', toolCalls: [], omittedBeforeChars: 0, droppedToolRefCount: 0 };
        this.insertFilteredTurn.run({
            memory_id: memoryId,
            included: projection.included ? 1 : 0,
            user_prompt: stored.userPrompt,
            assistant_response: stored.assistantResponse,
            tool_calls: JSON.stringify(stored.toolCalls),
            omitted_tool_call_count: projection.included ? projection.omittedToolCallCount : 0,
            dropped_tool_ref_count: stored.droppedToolRefCount,
            omitted_before_chars: stored.omittedBeforeChars,
            filter_version: projection.filterVersion,
            captured_at: capturedAt,
        });
        const row = this.sessionCaptureState.get(sessionId, sessionId) as { state: DurableCaptureState };
        this.upsertStatus.run(sessionId, row.state, projection.filterVersion, capturedAt);
        return this.enforceMaxBytes(sessionId, maxBytes, capturedAt, evictionPlan);
    }

    setStatus(sessionId: number, state: DurableCaptureState, updatedAt: string): void {
        this.upsertStatus.run(sessionId, state, DURABLE_CAPTURE_FILTER_VERSION, updatedAt);
    }

    refreshStatus(sessionId: number, updatedAt: string): DurableCaptureState {
        const row = this.sessionCaptureState.get(sessionId, sessionId) as { state: DurableCaptureState };
        this.setStatus(sessionId, row.state, updatedAt);
        return row.state;
    }

    private enforceMaxBytes(
        currentSessionId: number,
        maxBytes: number,
        updatedAt: string,
        evictionPlan?: DurableEvictionPlan,
    ): DurableCaptureRecordResult {
        let totalBytes = (this.totalBytes.get() as { total_bytes: number }).total_bytes;
        if (totalBytes <= maxBytes) {
            return 'retained';
        }
        const candidates = this.evictionCandidates.all() as EvictionCandidate[];
        const recoverable: EvictionCandidate[] = [];
        const unavailable: EvictionCandidate[] = [];
        let recoverableCurrent: EvictionCandidate | undefined;
        let currentEvicted = false;
        // Both lists retain the oldest-first SQL order. Exhausting the
        // recoverable list first protects copies whose provider transcript
        // has already disappeared and therefore cannot be rebuilt.
        for (const candidate of candidates) {
            if (candidate.id === currentSessionId) {
                if (evictionPlan?.isCurrentRecoverable(candidate) === true) {
                    recoverableCurrent = candidate;
                } else {
                    unavailable.push(candidate);
                }
                continue;
            }
            (evictionPlan?.isRecoverable(candidate) === true ? recoverable : unavailable).push(candidate);
        }
        for (const victim of recoverable) {
            this.deleteSessionTurns.run(victim.id);
            this.upsertStatus.run(victim.id, 'evicted', DURABLE_CAPTURE_FILTER_VERSION, updatedAt);
            totalBytes = (this.totalBytes.get() as { total_bytes: number }).total_bytes;
            if (totalBytes <= maxBytes) {
                return 'retained';
            }
        }
        if (recoverableCurrent) {
            this.deleteSessionTurns.run(recoverableCurrent.id);
            this.upsertStatus.run(recoverableCurrent.id, 'evicted', DURABLE_CAPTURE_FILTER_VERSION, updatedAt);
            currentEvicted = true;
            totalBytes = (this.totalBytes.get() as { total_bytes: number }).total_bytes;
            if (totalBytes <= maxBytes) {
                return 'not_retained';
            }
        }
        for (const victim of unavailable) {
            this.deleteSessionTurns.run(victim.id);
            this.upsertStatus.run(victim.id, 'evicted', DURABLE_CAPTURE_FILTER_VERSION, updatedAt);
            currentEvicted ||= victim.id === currentSessionId;
            totalBytes = (this.totalBytes.get() as { total_bytes: number }).total_bytes;
            if (totalBytes <= maxBytes) {
                return currentEvicted ? 'not_retained' : 'retained';
            }
        }
        return 'not_retained';
    }
}
