import { statSync } from 'node:fs';
import type { Database } from 'better-sqlite3-multiple-ciphers';
import { TASK_STATE_REPORT_MODES, TASK_STATE_REQUEST_ID_PATTERN } from '../config/constants.js';
import { canonicalizeExisting, samePath } from '../config/paths.js';
import { wrap } from '../security/sentinel.js';
import type { TaskStateReportMode, ToolName } from '../types/index.js';
import { ConsentStore } from './consent-store.js';
import { isRetentionRemoved } from './live-memory-retention-schema.js';
import { newUlid } from './ulid.js';

interface PhysicalCheckout {
    path: string;
    dev: string;
    ino: string;
}

interface AuthorizedCheckout extends PhysicalCheckout {
    consentUlid: string;
    consentDecidedAt: string;
}

export interface PreparedTaskStateRequest {
    tool: ToolName;
    nativeSessionId: string;
    cwd: string;
    mode: TaskStateReportMode;
    requestId: string;
    checkout: AuthorizedCheckout;
}

interface CurrentSession {
    id: number;
    kind: string | null;
    source_format: string;
    source_path: string;
    project_path: string;
    source_generation: number;
    last_turn_index: number;
}

interface RequestRow {
    request_id: string;
    injection_row_id: number;
    session_id: number;
    tool: ToolName;
    native_session_id: string;
    mode: TaskStateReportMode;
    physical_checkout: string;
    checkout_dev: string;
    checkout_ino: string;
    consent_ulid: string | null;
    consent_decided_at: string | null;
    source_path: string;
    source_generation: number;
    after_turn_index: number;
    issued_at: string;
    consumed_at: string | null;
    injection_tool: ToolName;
    injection_native_session_id: string;
    injection_id: string;
    injection_body: string;
    injection_at: string;
}

export interface TaskStateRequestScope {
    requestId: string;
    mode: TaskStateReportMode;
    tool: ToolName;
    nativeSessionId: string;
    sessionId: number;
    cwd: string;
    sourcePath: string;
    turnIndex: number;
}

function physicalCheckout(value: string): PhysicalCheckout | undefined {
    try {
        const physical = canonicalizeExisting(value);
        const stat = statSync(physical, { bigint: true });
        if (!stat.isDirectory()) {
            return undefined;
        }
        return { path: physical, dev: stat.dev.toString(), ino: stat.ino.toString() };
    } catch {
        return undefined;
    }
}

function validMode(mode: string): mode is TaskStateReportMode {
    return (TASK_STATE_REPORT_MODES as readonly string[]).includes(mode);
}

export function newTaskStateRequestId(): string {
    return newUlid();
}

// The hook writes this literal into the exact recorded injection before
// issuing the request; a report_id appearing only in transcript data cannot
// create authority.
export function taskStateRequestMarker(mode: TaskStateReportMode, requestId: string): string {
    if (!validMode(mode) || !TASK_STATE_REQUEST_ID_PATTERN.test(requestId)) {
        throw new Error('Invalid task-state request marker');
    }
    return `elepha task-state request mode=${mode} request_id=${requestId}`;
}

export class TaskStateRequestStore {
    private readonly consent: ConsentStore;

    constructor(private readonly db: Database) {
        this.consent = new ConsentStore(db);
    }

    private currentSession(tool: ToolName, nativeSessionId: string): CurrentSession | undefined {
        return this.db
            .prepare(`SELECT s.id, s.kind, s.source_format, s.source_path, p.path AS project_path,
                COALESCE(g.generation, 0) AS source_generation,
                COALESCE((SELECT MAX(m.turn_index) FROM memories m
                    JOIN sessions prior ON prior.id = m.session_id
                    WHERE prior.tool = s.tool AND prior.native_id = s.native_id), -1) AS last_turn_index
                FROM sessions s JOIN projects p ON p.id = s.project_id
                LEFT JOIN source_generations g ON g.tool = s.tool AND g.native_id = s.native_id
                WHERE s.tool = ? AND s.native_id = ?
                ORDER BY s.segment_index DESC LIMIT 1`)
            .get(tool, nativeSessionId) as CurrentSession | undefined;
    }

    private allowedCheckout(cwd: string): AuthorizedCheckout | undefined {
        if (this.consent.consentState(cwd) !== 'approved' || this.consent.isRefusedForCapture(cwd)) {
            return undefined;
        }
        const checkout = physicalCheckout(cwd);
        if (checkout === undefined) {
            return undefined;
        }
        const decision = this.consent.approvedDecisionForCanonicalPath(checkout.path);
        return decision === undefined ? undefined : { ...checkout, consentUlid: decision.ulid, consentDecidedAt: decision.decided_at };
    }

    // Resolve the physical checkout before acquiring the injection write lock.
    prepareIssue(input: {
        tool: ToolName;
        nativeSessionId: string;
        cwd: string;
        mode: TaskStateReportMode;
        requestId: string;
    }): PreparedTaskStateRequest | undefined {
        if (input.tool === 'opencode' || !validMode(input.mode) || !TASK_STATE_REQUEST_ID_PATTERN.test(input.requestId)) {
            return undefined;
        }
        const checkout = this.allowedCheckout(input.cwd);
        if (checkout === undefined) {
            return undefined;
        }
        return { ...input, checkout };
    }

    // Call inside the same DB transaction that records the hook injection.
    // A missing main session (common on the first prompt) is a no-op.
    issuePrepared(input: PreparedTaskStateRequest, injectionId: string): boolean {
        const checkout = input.checkout;
        return this.db.transaction(() => {
            const session = this.currentSession(input.tool, input.nativeSessionId);
            const decision = this.consent.approvedDecisionForCanonicalPath(checkout.path);
            if (
                session?.kind !== 'main' ||
                session.source_format !== 'native' ||
                !samePath(session.project_path, checkout.path) ||
                this.db
                    .prepare('SELECT 1 FROM purged_transcripts WHERE tool = ? AND native_id = ?')
                    .get(input.tool, input.nativeSessionId) !== undefined ||
                isRetentionRemoved(this.db, input.tool, input.nativeSessionId) ||
                this.db
                    .prepare('SELECT 1 FROM incognito_transcripts WHERE tool = ? AND native_id = ?')
                    .get(input.tool, input.nativeSessionId) !== undefined ||
                decision?.ulid !== checkout.consentUlid ||
                decision?.decided_at !== checkout.consentDecidedAt
            ) {
                return false;
            }
            const pending = this.db
                .prepare(`SELECT request_id, consumed_at, source_path, after_turn_index FROM task_state_requests
                    WHERE tool = ? AND native_session_id = ? AND mode = ?`)
                .get(input.tool, input.nativeSessionId, input.mode) as
                | { request_id: string; consumed_at: string | null; source_path: string; after_turn_index: number }
                | undefined;
            if (
                pending?.consumed_at === null &&
                this.matchesDatabaseState(
                    {
                        requestId: pending.request_id,
                        mode: input.mode,
                        tool: input.tool,
                        nativeSessionId: input.nativeSessionId,
                        sessionId: session.id,
                        cwd: input.cwd,
                        sourcePath: pending.source_path,
                        turnIndex: pending.after_turn_index + 1,
                    },
                    checkout,
                )
            ) {
                // A second ordinary prompt must not invalidate an in-flight
                // report. The caller rolls back its unneeded new injection.
                return false;
            }
            const injections = this.db
                .prepare(
                    'SELECT id, body, injected_at FROM injections WHERE tool = ? AND native_session_id = ? AND injection_id = ? LIMIT 2',
                )
                .all(input.tool, input.nativeSessionId, injectionId) as Array<{ id: number; body: string; injected_at: string }>;
            if (injections.length !== 1 || !injections[0]?.body.includes(taskStateRequestMarker(input.mode, input.requestId))) {
                return false;
            }
            this.db
                .prepare('DELETE FROM task_state_requests WHERE tool = ? AND native_session_id = ? AND mode = ?')
                .run(input.tool, input.nativeSessionId, input.mode);
            this.db
                .prepare(`INSERT INTO task_state_requests
                    (request_id, injection_row_id, session_id, tool, native_session_id, mode,
                     physical_checkout, checkout_dev, checkout_ino, consent_ulid, consent_decided_at,
                     source_path, source_generation, after_turn_index, issued_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
                .run(
                    input.requestId,
                    injections[0].id,
                    session.id,
                    input.tool,
                    input.nativeSessionId,
                    input.mode,
                    checkout.path,
                    checkout.dev,
                    checkout.ino,
                    checkout.consentUlid,
                    checkout.consentDecidedAt,
                    session.source_path,
                    session.source_generation,
                    session.last_turn_index,
                    injections[0].injected_at,
                );
            return true;
        })();
    }

    issue(input: {
        tool: ToolName;
        nativeSessionId: string;
        cwd: string;
        mode: TaskStateReportMode;
        requestId: string;
        injectionId: string;
    }): boolean {
        const prepared = this.prepareIssue(input);
        return prepared !== undefined && this.issuePrepared(prepared, input.injectionId);
    }

    private request(requestId: string): RequestRow | undefined {
        return this.db
            .prepare(`SELECT r.*, i.tool AS injection_tool, i.native_session_id AS injection_native_session_id,
                i.injection_id, i.body AS injection_body, i.injected_at AS injection_at
                FROM task_state_requests r JOIN injections i ON i.id = r.injection_row_id
                WHERE r.request_id = ?`)
            .get(requestId) as RequestRow | undefined;
    }

    // Reuse the exact recorded wrapper while a model report is pending. The
    // hook independently revalidates the opened provider source first.
    currentPendingOutput(input: {
        tool: ToolName;
        nativeSessionId: string;
        cwd: string;
        mode: TaskStateReportMode;
    }): { requestId: string; output: string } | undefined {
        const checkout = this.allowedCheckout(input.cwd);
        const session = this.currentSession(input.tool, input.nativeSessionId);
        if (checkout === undefined || session === undefined) {
            return undefined;
        }
        const pending = this.db
            .prepare(`SELECT request_id, after_turn_index, source_path FROM task_state_requests
                WHERE tool = ? AND native_session_id = ? AND mode = ? AND consumed_at IS NULL`)
            .get(input.tool, input.nativeSessionId, input.mode) as
            | { request_id: string; after_turn_index: number; source_path: string }
            | undefined;
        const current =
            pending !== undefined &&
            this.matchesDatabaseState(
                {
                    requestId: pending.request_id,
                    mode: input.mode,
                    tool: input.tool,
                    nativeSessionId: input.nativeSessionId,
                    sessionId: session.id,
                    cwd: input.cwd,
                    sourcePath: pending.source_path,
                    turnIndex: pending.after_turn_index + 1,
                },
                checkout,
            );
        if (!current) {
            return undefined;
        }
        const request = this.request(pending.request_id);
        return request === undefined
            ? undefined
            : { requestId: pending.request_id, output: wrap('brief', request.injection_id, request.injection_body) };
    }

    // This is an inexpensive admission check, not authorization. Consumption
    // repeats every durable condition in a transaction after source proof.
    canConsume(input: TaskStateRequestScope): boolean {
        if (input.tool === 'opencode' || !TASK_STATE_REQUEST_ID_PATTERN.test(input.requestId)) {
            return false;
        }
        const checkout = this.allowedCheckout(input.cwd);
        return checkout !== undefined && this.matchesDatabaseState(input, checkout);
    }

    private matchesDatabaseState(input: TaskStateRequestScope, checkout: AuthorizedCheckout): boolean {
        const request = this.request(input.requestId);
        const session = this.currentSession(input.tool, input.nativeSessionId);
        const decision = this.consent.approvedDecisionForCanonicalPath(checkout.path);
        if (request === undefined || session === undefined) {
            return false;
        }
        return (
            request.consumed_at === null &&
            request.mode === input.mode &&
            request.tool === input.tool &&
            request.native_session_id === input.nativeSessionId &&
            request.session_id === input.sessionId &&
            session.id === input.sessionId &&
            session.kind === 'main' &&
            session.source_format === 'native' &&
            samePath(session.project_path, checkout.path) &&
            samePath(request.physical_checkout, checkout.path) &&
            request.checkout_dev === checkout.dev &&
            request.checkout_ino === checkout.ino &&
            request.consent_ulid === checkout.consentUlid &&
            request.consent_decided_at === checkout.consentDecidedAt &&
            request.source_path === input.sourcePath &&
            session.source_path === input.sourcePath &&
            request.source_generation === session.source_generation &&
            request.after_turn_index < input.turnIndex &&
            request.injection_tool === input.tool &&
            request.injection_native_session_id === input.nativeSessionId &&
            request.injection_at === request.issued_at &&
            request.injection_body.includes(taskStateRequestMarker(input.mode, input.requestId)) &&
            decision?.ulid === checkout.consentUlid &&
            decision?.decided_at === checkout.consentDecidedAt &&
            this.db.prepare('SELECT 1 FROM purged_transcripts WHERE tool = ? AND native_id = ?').get(input.tool, input.nativeSessionId) ===
                undefined &&
            !isRetentionRemoved(this.db, input.tool, input.nativeSessionId) &&
            this.db
                .prepare('SELECT 1 FROM incognito_transcripts WHERE tool = ? AND native_id = ?')
                .get(input.tool, input.nativeSessionId) === undefined
        );
    }

    consumeForVerifiedManifest(input: TaskStateRequestScope, insert: () => boolean): boolean {
        // Filesystem identity must be read before SQLite's write lock. The
        // daemon separately revalidates the opened transcript handle.
        if (input.tool === 'opencode' || !TASK_STATE_REQUEST_ID_PATTERN.test(input.requestId)) {
            return false;
        }
        const checkout = this.allowedCheckout(input.cwd);
        if (checkout === undefined || !this.matchesDatabaseState(input, checkout)) {
            return false;
        }
        return this.db.transaction(() => {
            if (!this.matchesDatabaseState(input, checkout)) {
                return false;
            }
            if (!insert()) {
                return false;
            }
            const result = this.db
                .prepare('UPDATE task_state_requests SET consumed_at = ? WHERE request_id = ? AND consumed_at IS NULL')
                .run(new Date().toISOString(), input.requestId);
            if (result.changes !== 1) {
                throw new Error('Task-state request was not consumed once');
            }
            return true;
        })();
    }
}
