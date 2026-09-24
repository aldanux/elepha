import { createHash } from 'node:crypto';
import type { Database, Statement } from 'better-sqlite3-multiple-ciphers';
import {
    ELEPHA_MCP_CALL_ID_MAX_BYTES,
    INJECTION_QUOTE_BACK_BUDGET_MS,
    INJECTION_QUOTE_BACK_MAX_BYTES,
    INJECTION_QUOTE_BACK_MAX_ROWS,
    INJECTION_QUOTE_BACK_TURN_MAX_BYTES,
} from '../config/constants.js';
import { nearVerbatimStatusNormalized, normalizeForNearVerbatim, turnText } from '../security/self-ingestion.js';
import type { ParsedTurn, ToolName } from '../types/index.js';

export interface InjectionRow {
    id: number;
    tool: ToolName;
    native_session_id: string;
    injected_at: string;
    injection_id: string;
    body_hash: string;
    body: string;
}

export interface McpReceiptRow {
    id: number;
    tool: ToolName;
    native_session_id: string;
    source_generation: number;
    source_turn_index: number;
    call_id: string;
    observed_at: string | null;
    body_hash: string;
    body: string;
}

export type InjectionAttribution = 'normalized' | 'exact';

export function injectionBodyHash(body: string, attribution: InjectionAttribution = 'normalized'): string {
    const digest = createHash('sha256')
        .update(attribution === 'exact' ? body : normalizeForNearVerbatim(body))
        .digest('hex');
    return attribution === 'exact' ? `exact:${digest}` : digest;
}

export interface RecordInjectionInput {
    tool: ToolName;
    nativeSessionId: string;
    injectedAt: string;
    injectionId: string;
    body: string;
    attribution?: InjectionAttribution;
}

export type InjectionQuoteBackResult = 'match' | 'no-match' | 'incomplete';

export class InjectionQuoteBackIncompleteError extends Error {
    constructor(context: string) {
        super(`${context}: quote-back protection incomplete`);
        this.name = 'InjectionQuoteBackIncompleteError';
    }
}

export class InjectionStore {
    private readonly transientMcpReceipts: McpReceiptRow[] = [];
    private readonly transientTotals = new Map<string, { rows: number; bytes: number }>();
    private readonly encounteredMcpReceipts = new Map<string, { sourceTurnIndex: number; body: string }>();
    private readonly includePersistedMcp: boolean;
    private readonly now: () => number;
    private readonly stmts: {
        insertInjection: Statement;
        injectionsForSession: Statement;
        injectionsForPrefix: Statement;
        countForPrefix: Statement;
        hookCandidateExists: Statement;
        hookBodiesForSession: Statement;
        injectionBodyById: Statement;
        sourceGeneration: Statement;
        ensureSourceGeneration: Statement;
        insertMcpReceipt: Statement;
        mcpReceiptByCall: Statement;
        mcpBodiesForSession: Statement;
        mcpReceiptBodyById: Statement;
        mcpReceiptsForSession: Statement;
        retainedTotals: Statement;
    };

    constructor(db: Database, options: { includePersistedMcp?: boolean; now?: () => number } = {}) {
        this.includePersistedMcp = options.includePersistedMcp ?? true;
        this.now = options.now ?? Date.now;
        this.stmts = {
            injectionsForPrefix: db.prepare(
                'SELECT 1 FROM injections WHERE tool = ? AND native_session_id = ? AND substr(body, 1, ?) = ? LIMIT 1',
            ),
            countForPrefix: db.prepare(
                'SELECT count(*) AS count FROM injections WHERE tool = ? AND native_session_id = ? AND substr(body, 1, ?) = ?',
            ),
            insertInjection: db.prepare(
                `INSERT OR IGNORE INTO injections (tool, native_session_id, injected_at, injection_id, body_hash, body)
                 VALUES (@tool, @native_session_id, @injected_at, @injection_id, @body_hash, @body)`,
            ),
            hookCandidateExists: db.prepare('SELECT 1 FROM injections WHERE tool = ? AND native_session_id = ? LIMIT 1'),
            hookBodiesForSession: db.prepare(
                `SELECT id, length(CAST(body AS BLOB)) AS body_bytes FROM injections
                 WHERE tool = ? AND native_session_id = ? AND injected_at <= ?
                 ORDER BY injected_at ASC, id ASC
                 LIMIT ${INJECTION_QUOTE_BACK_MAX_ROWS + 1}`,
            ),
            injectionBodyById: db.prepare('SELECT body FROM injections WHERE id = ?'),
            injectionsForSession: db.prepare(
                `SELECT * FROM injections
                 WHERE tool = ? AND native_session_id = ? AND injected_at <= ?
                 ORDER BY injected_at ASC, id ASC`,
            ),
            sourceGeneration: db.prepare('SELECT generation FROM source_generations WHERE tool = ? AND native_id = ?'),
            ensureSourceGeneration: db.prepare('INSERT OR IGNORE INTO source_generations (tool, native_id, generation) VALUES (?, ?, 0)'),
            insertMcpReceipt: db.prepare(
                `INSERT OR IGNORE INTO mcp_receipts
                 (tool, native_session_id, source_generation, source_turn_index, call_id, observed_at, body_hash, body)
                 VALUES (@tool, @native_session_id, @source_generation, @source_turn_index, @call_id, @observed_at, @body_hash, @body)`,
            ),
            mcpReceiptByCall: db.prepare(
                `SELECT * FROM mcp_receipts
                 WHERE tool = ? AND native_session_id = ? AND source_generation = ? AND call_id = ? LIMIT 1`,
            ),
            mcpBodiesForSession: db.prepare(
                `SELECT id, length(CAST(body AS BLOB)) AS body_bytes FROM mcp_receipts
                 WHERE tool = ? AND native_session_id = ? AND source_generation = ? AND source_turn_index < ?
                 ORDER BY source_turn_index ASC, id ASC
                 LIMIT ${INJECTION_QUOTE_BACK_MAX_ROWS + 1}`,
            ),
            mcpReceiptBodyById: db.prepare('SELECT body FROM mcp_receipts WHERE id = ?'),
            mcpReceiptsForSession: db.prepare(
                `SELECT * FROM mcp_receipts
                 WHERE tool = ? AND native_session_id = ? AND source_generation = ?
                 ORDER BY source_turn_index ASC, id ASC`,
            ),
            retainedTotals: db.prepare(
                `SELECT
                   (SELECT count(*) FROM injections WHERE tool = ? AND native_session_id = ?) +
                   (SELECT count(*) FROM mcp_receipts WHERE tool = ? AND native_session_id = ?) AS count,
                   (SELECT coalesce(sum(length(CAST(body AS BLOB))), 0) FROM injections
                    WHERE tool = ? AND native_session_id = ?) +
                   (SELECT coalesce(sum(length(CAST(body AS BLOB))), 0) FROM mcp_receipts
                    WHERE tool = ? AND native_session_id = ?) AS bytes`,
            ),
        };
    }

    // Stores a future hook injection's exact body once; normalized-hash
    // uniqueness preserves the original hook contract and timestamp gating.
    // Explicit user rules use namespaced exact identity so case/punctuation
    // edits remain separately attributable without changing legacy bodies.
    recordInjection(input: RecordInjectionInput): boolean {
        const bodyHash = injectionBodyHash(input.body, input.attribution);
        const result = this.stmts.insertInjection.run({
            tool: input.tool,
            native_session_id: input.nativeSessionId,
            injected_at: input.injectedAt,
            injection_id: input.injectionId,
            body_hash: bodyHash,
            body: input.body,
        });
        if (result.changes > 0) {
            return true;
        }
        // INSERT OR IGNORE is not proof: SQLite can ignore for a different
        // constraint or a damaged statement. A repeated body is durable only
        // when the exact scoped row is observable before stdout is written.
        return this.injectionsForSession(input.tool, input.nativeSessionId, input.injectedAt).some(
            (row) => row.body_hash === bodyHash && row.body === input.body,
        );
    }

    currentSourceGeneration(tool: ToolName, nativeSessionId: string): number {
        return (this.stmts.sourceGeneration.get(tool, nativeSessionId) as { generation: number } | undefined)?.generation ?? 0;
    }

    recordElephaMcpReceipts(turn: ParsedTurn, sourceGeneration = this.currentSourceGeneration(turn.tool, turn.sessionId)): boolean {
        if (turn.droppedReason !== 'elepha-mcp' || (turn.elephaMcpResultReceipts?.length ?? 0) === 0) {
            return turn.droppedReason !== 'elepha-mcp';
        }
        if ((turn.elephaMcpResultReceipts ?? []).some((receipt) => !validMcpCallId(receipt.callId))) {
            return false;
        }
        this.stmts.ensureSourceGeneration.run(turn.tool, turn.sessionId);
        for (const receipt of turn.elephaMcpResultReceipts ?? []) {
            const existing = this.stmts.mcpReceiptByCall.get(turn.tool, turn.sessionId, sourceGeneration, receipt.callId) as
                | McpReceiptRow
                | undefined;
            if (existing !== undefined) {
                if (existing.source_turn_index !== turn.turnIndex || existing.body !== receipt.body) {
                    return false;
                }
                continue;
            }
            if (!this.canRetainMcpReceipt(turn.tool, turn.sessionId, Buffer.byteLength(receipt.body))) {
                return false;
            }
            const result = this.stmts.insertMcpReceipt.run({
                tool: turn.tool,
                native_session_id: turn.sessionId,
                source_generation: sourceGeneration,
                source_turn_index: turn.turnIndex,
                call_id: receipt.callId,
                observed_at: canonicalObservedAt(receipt.observedAt),
                body_hash: createHash('sha256').update(receipt.body).digest('hex'),
                body: receipt.body,
            });
            if (result.changes === 0) {
                const replay = this.stmts.mcpReceiptByCall.get(turn.tool, turn.sessionId, sourceGeneration, receipt.callId) as
                    | McpReceiptRow
                    | undefined;
                if (replay?.source_turn_index !== turn.turnIndex || replay.body !== receipt.body) {
                    return false;
                }
            }
        }
        return true;
    }

    // Metadata and source replays learn structural MCP evidence for later
    // turns in the same walk without mutating durable receipt state.
    rememberElephaMcpReceipts(turn: ParsedTurn, sourceGeneration = this.currentSourceGeneration(turn.tool, turn.sessionId)): boolean {
        if (turn.droppedReason !== 'elepha-mcp' || (turn.elephaMcpResultReceipts?.length ?? 0) === 0) {
            return turn.droppedReason !== 'elepha-mcp';
        }
        if ((turn.elephaMcpResultReceipts ?? []).some((receipt) => !validMcpCallId(receipt.callId))) {
            return false;
        }
        for (const receipt of turn.elephaMcpResultReceipts ?? []) {
            const encounterKey = receiptIdentity(turn.tool, turn.sessionId, sourceGeneration, receipt.callId);
            const encountered = this.encounteredMcpReceipts.get(encounterKey);
            if (encountered !== undefined) {
                if (encountered.sourceTurnIndex !== turn.turnIndex || encountered.body !== receipt.body) {
                    return false;
                }
                continue;
            }
            if (this.includePersistedMcp) {
                const persisted = this.stmts.mcpReceiptByCall.get(turn.tool, turn.sessionId, sourceGeneration, receipt.callId) as
                    | McpReceiptRow
                    | undefined;
                if (persisted !== undefined) {
                    if (persisted.source_turn_index !== turn.turnIndex || persisted.body !== receipt.body) {
                        return false;
                    }
                    this.encounteredMcpReceipts.set(encounterKey, {
                        sourceTurnIndex: turn.turnIndex,
                        body: receipt.body,
                    });
                    continue;
                }
            }
            const transient = this.transientMcpReceipts.find(
                (row) => row.tool === turn.tool && row.native_session_id === turn.sessionId && row.call_id === receipt.callId,
            );
            if (transient !== undefined) {
                if (transient.source_turn_index !== turn.turnIndex || transient.body !== receipt.body) {
                    return false;
                }
                continue;
            }
            const bodyBytes = Buffer.byteLength(receipt.body);
            if (!this.canRetainMcpReceipt(turn.tool, turn.sessionId, bodyBytes, true)) {
                return false;
            }
            const scope = receiptScope(turn.tool, turn.sessionId);
            const totals = this.transientTotals.get(scope) ?? { rows: 0, bytes: 0 };
            this.transientMcpReceipts.push({
                id: -this.transientMcpReceipts.length - 1,
                tool: turn.tool,
                native_session_id: turn.sessionId,
                source_generation: sourceGeneration,
                source_turn_index: turn.turnIndex,
                call_id: receipt.callId,
                observed_at: canonicalObservedAt(receipt.observedAt),
                body_hash: createHash('sha256').update(receipt.body).digest('hex'),
                body: receipt.body,
            });
            this.transientTotals.set(scope, { rows: totals.rows + 1, bytes: totals.bytes + bodyBytes });
            this.encounteredMcpReceipts.set(encounterKey, { sourceTurnIndex: turn.turnIndex, body: receipt.body });
        }
        return true;
    }

    validateCompleteMcpReceiptLedger(tool: ToolName, nativeSessionId: string, sourceGeneration: number): boolean {
        if (this.currentSourceGeneration(tool, nativeSessionId) !== sourceGeneration) {
            return false;
        }
        for (const persisted of this.mcpReceiptsForSession(tool, nativeSessionId, sourceGeneration)) {
            const encountered = this.encounteredMcpReceipts.get(
                receiptIdentity(tool, nativeSessionId, sourceGeneration, persisted.call_id),
            );
            if (
                encountered === undefined ||
                encountered.sourceTurnIndex !== persisted.source_turn_index ||
                encountered.body !== persisted.body
            ) {
                return false;
            }
        }
        return true;
    }

    injectionsForSession(tool: ToolName, nativeSessionId: string, atOrBefore: string): InjectionRow[] {
        return this.stmts.injectionsForSession.all(tool, nativeSessionId, atOrBefore) as InjectionRow[];
    }

    mcpReceiptsForSession(tool: ToolName, nativeSessionId: string, sourceGeneration: number): McpReceiptRow[] {
        return this.stmts.mcpReceiptsForSession.all(tool, nativeSessionId, sourceGeneration) as McpReceiptRow[];
    }

    // Query the existing hook injection index without loading its historical
    // bodies. A stable candidate prefix survives fresh DATA nonces and changed prompts.
    hasBodyPrefix(tool: ToolName, nativeSessionId: string, prefix: string): boolean {
        return this.stmts.injectionsForPrefix.get(tool, nativeSessionId, prefix.length, prefix) !== undefined;
    }

    countBodyPrefix(tool: ToolName, nativeSessionId: string, prefix: string): number {
        const row = this.stmts.countForPrefix.get(tool, nativeSessionId, prefix.length, prefix) as { count: number };
        return row.count;
    }

    quoteBackStatus(
        turn: Pick<ParsedTurn, 'sessionId' | 'turnIndex' | 'endedAt' | 'userMessage' | 'assistantText' | 'toolCalls'> & {
            tool: ToolName;
        },
    ): InjectionQuoteBackResult {
        let deadline: number | undefined;
        let rows = 0;
        let bytes = 0;
        let normalizedTurn: string | undefined;
        const matchBody = (body: string): InjectionQuoteBackResult | undefined => {
            deadline ??= this.now() + INJECTION_QUOTE_BACK_BUDGET_MS;
            if (normalizedTurn === undefined && !turnSurfaceWithinBudget(turn, deadline, this.now)) {
                return 'incomplete';
            }
            normalizedTurn ??= normalizeForNearVerbatim(turnText(turn));
            if (this.now() >= deadline) {
                return 'incomplete';
            }
            const result = nearVerbatimStatusNormalized(normalizedTurn, body, { deadline, now: this.now });
            return result === 'no-match' ? undefined : result;
        };
        const compare = (body: string): InjectionQuoteBackResult | undefined => {
            rows++;
            bytes += Buffer.byteLength(body);
            if (rows > INJECTION_QUOTE_BACK_MAX_ROWS || bytes > INJECTION_QUOTE_BACK_MAX_BYTES) {
                return 'incomplete';
            }
            return matchBody(body);
        };
        try {
            const hookCandidateExists = this.stmts.hookCandidateExists.get(turn.tool, turn.sessionId) !== undefined;
            if (hookCandidateExists) {
                const endedAt = canonicalObservedAt(turn.endedAt);
                if (endedAt === null) {
                    return 'incomplete';
                }
                for (const candidate of this.stmts.hookBodiesForSession.iterate(turn.tool, turn.sessionId, endedAt) as Iterable<{
                    id: number;
                    body_bytes: number;
                }>) {
                    if (deadline !== undefined && this.now() >= deadline) {
                        return 'incomplete';
                    }
                    rows++;
                    bytes += candidate.body_bytes;
                    if (rows > INJECTION_QUOTE_BACK_MAX_ROWS || bytes > INJECTION_QUOTE_BACK_MAX_BYTES) {
                        return 'incomplete';
                    }
                    const row = this.stmts.injectionBodyById.get(candidate.id) as { body: string } | undefined;
                    if (row === undefined) {
                        return 'incomplete';
                    }
                    const result = matchBody(row.body);
                    if (result !== undefined) {
                        return result;
                    }
                }
            }
            if (this.includePersistedMcp) {
                const generation = this.currentSourceGeneration(turn.tool, turn.sessionId);
                for (const candidate of this.stmts.mcpBodiesForSession.iterate(
                    turn.tool,
                    turn.sessionId,
                    generation,
                    turn.turnIndex,
                ) as Iterable<{ id: number; body_bytes: number }>) {
                    if (deadline !== undefined && this.now() >= deadline) {
                        return 'incomplete';
                    }
                    rows++;
                    bytes += candidate.body_bytes;
                    if (rows > INJECTION_QUOTE_BACK_MAX_ROWS || bytes > INJECTION_QUOTE_BACK_MAX_BYTES) {
                        return 'incomplete';
                    }
                    const row = this.stmts.mcpReceiptBodyById.get(candidate.id) as { body: string } | undefined;
                    if (row === undefined) {
                        return 'incomplete';
                    }
                    const result = matchBody(row.body);
                    if (result !== undefined) {
                        return result;
                    }
                }
            }
            for (const receipt of this.transientMcpReceipts) {
                if (deadline !== undefined && this.now() >= deadline) {
                    return 'incomplete';
                }
                if (
                    receipt.tool !== turn.tool ||
                    receipt.native_session_id !== turn.sessionId ||
                    receipt.source_turn_index >= turn.turnIndex
                ) {
                    continue;
                }
                const result = compare(receipt.body);
                if (result !== undefined) {
                    return result;
                }
            }
            return deadline !== undefined && this.now() >= deadline ? 'incomplete' : 'no-match';
        } catch {
            return 'incomplete';
        }
    }

    isQuoteBackOrThrow(turn: ParsedTurn, context: string): boolean {
        const status = this.quoteBackStatus(turn);
        if (status === 'incomplete') {
            throw new InjectionQuoteBackIncompleteError(context);
        }
        return status === 'match';
    }

    private canRetainMcpReceipt(tool: ToolName, nativeSessionId: string, bodyBytes: number, includeTransient = false): boolean {
        const totals = this.stmts.retainedTotals.get(
            tool,
            nativeSessionId,
            tool,
            nativeSessionId,
            tool,
            nativeSessionId,
            tool,
            nativeSessionId,
        ) as { count: number; bytes: number };
        const transient = includeTransient
            ? (this.transientTotals.get(receiptScope(tool, nativeSessionId)) ?? { rows: 0, bytes: 0 })
            : null;
        return (
            totals.count + (transient?.rows ?? 0) < INJECTION_QUOTE_BACK_MAX_ROWS &&
            totals.bytes + (transient?.bytes ?? 0) + bodyBytes <= INJECTION_QUOTE_BACK_MAX_BYTES
        );
    }
}

function canonicalObservedAt(value: string | null | undefined): string | null {
    if (value === null || value === undefined) {
        return null;
    }
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function receiptScope(tool: ToolName, nativeSessionId: string): string {
    return `${tool}\0${nativeSessionId}`;
}

function receiptIdentity(tool: ToolName, nativeSessionId: string, sourceGeneration: number, callId: string): string {
    return `${tool}\0${nativeSessionId}\0${sourceGeneration}\0${callId}`;
}

function validMcpCallId(callId: string): boolean {
    return callId !== '' && Buffer.byteLength(callId) <= ELEPHA_MCP_CALL_ID_MAX_BYTES;
}

function turnSurfaceWithinBudget(
    turn: Pick<ParsedTurn, 'userMessage' | 'assistantText' | 'toolCalls'>,
    deadline: number,
    now: () => number,
): boolean {
    let bytes = 2;
    const add = (value: string, overhead = 1, expansion = 1): boolean => {
        bytes += Buffer.byteLength(value) * expansion + overhead;
        return bytes <= INJECTION_QUOTE_BACK_TURN_MAX_BYTES && now() < deadline;
    };
    if (!add(turn.userMessage) || !add(turn.assistantText)) {
        return false;
    }
    for (const call of turn.toolCalls) {
        // Tool calls are JSON-encoded by turnText. Six output bytes per
        // source byte covers the longest JSON control-character escape.
        bytes += 64;
        if (bytes > INJECTION_QUOTE_BACK_TURN_MAX_BYTES || !add(call.name, 1, 6)) {
            return false;
        }
        if (call.text !== undefined && !add(call.text, 1, 6)) {
            return false;
        }
        for (const filePath of call.filePaths) {
            if (!add(filePath, 4, 6)) {
                return false;
            }
        }
    }
    return true;
}
