import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3-multiple-ciphers';
import { sessionAdapterFor } from '../adapters/index.js';
import { TRAILING_FILES_CAP } from '../config/constants.js';
import { dedupePaths } from '../config/paths.js';
import { RAW_TURN_SEPARATOR, renderRawTurn } from '../rendering/raw-turn-renderer.js';
import { openProviderTranscript } from '../security/provider-transcript.js';
import { stripShellSyntax } from '../security/sanitize.js';
import type { ParsedTurn, SessionAdapterMap, ToolName } from '../types/index.js';
import { firstPromptSearch } from './first-prompt-search.js';
import { InjectionStore } from './injection-store.js';
import type { MemoryStore } from './memory-store.js';
import {
    type AuthenticatedReadGeneration,
    LOCKED_MEMORY_MESSAGE,
    memoryReadAuthorityMatchesGenerationInTransaction,
    withMemoryReadGeneration,
} from './paranoid-gate.js';
import { titleForTurn } from './session-title.js';
import { sourceGeneration, sourceSnapshotValidator } from './source-reconciliation.js';

interface RepairSession {
    id: number;
    project_path: string;
    source_path: string;
    segment_index: number;
}

interface DerivedSession {
    renderedChars: number;
    renderedTurns: number;
    title: string | null;
    firstPrompt: string | null;
    lastTurnAt: string | null;
    trailingBranch: string | null;
    trailingFiles: string[];
    observed: number;
}

export interface McpRepairPlan {
    tool: ToolName;
    nativeId: string;
    sourcePath: string;
    sessions: RepairSession[];
    memories: { id: number; session_id: number; turn_index: number }[];
    receipts: ParsedTurn[];
    missingReceipts: { turnIndex: number; callId: string }[];
    readGeneration: AuthenticatedReadGeneration;
    generation: number;
    fingerprint: string;
    derived: Map<number, DerivedSession>;
    validateSource: () => boolean;
    close: () => Promise<void>;
}

function derivedFor(plan: McpRepairPlan, id: number): DerivedSession {
    const derived = plan.derived.get(id);
    if (derived === undefined) {
        throw new Error('MCP repair session changed after preview');
    }
    return derived;
}

// Bind all derived rows, not just counts: a concurrent replacement with the
// same identifiers must invalidate the preview just as an appended turn does.
function fingerprint(db: Database.Database, tool: ToolName, nativeId: string): string {
    const hash = createHash('sha256');
    const scope = 'SELECT id FROM sessions WHERE tool = ? AND native_id = ?';
    const queries = [
        `SELECT * FROM sessions WHERE id IN (${scope}) ORDER BY id`,
        `SELECT * FROM projects WHERE id IN (SELECT project_id FROM sessions WHERE id IN (${scope})) ORDER BY id`,
        `SELECT * FROM memories WHERE session_id IN (${scope}) ORDER BY id`,
        `SELECT * FROM filtered_turns WHERE memory_id IN (SELECT id FROM memories WHERE session_id IN (${scope})) ORDER BY memory_id`,
        `SELECT * FROM session_rollups WHERE session_id IN (${scope}) ORDER BY session_id`,
        `SELECT * FROM session_embeddings WHERE session_id IN (${scope}) ORDER BY session_id`,
        `SELECT * FROM durable_capture_status WHERE session_id IN (${scope}) ORDER BY session_id`,
        'SELECT * FROM mcp_receipts WHERE tool = ? AND native_session_id = ? ORDER BY id',
    ];
    for (const query of queries) {
        hash.update(query);
        for (const row of db.prepare(query).iterate(tool, nativeId)) {
            hash.update(JSON.stringify(row));
        }
    }
    return hash.digest('hex');
}

function assertAuthorized(store: MemoryStore, plan: McpRepairPlan): void {
    withMemoryReadGeneration(store.database, refuseLocked, () => undefined, plan.readGeneration);
    if (
        !plan.validateSource() ||
        sourceGeneration(store, plan.tool, plan.nativeId) !== plan.generation ||
        store.isTranscriptPurged(plan.tool, plan.nativeId) ||
        store.isTranscriptIncognito(plan.tool, plan.nativeId) ||
        plan.sessions.some((session) => store.consent.consentState(session.project_path) !== 'approved')
    ) {
        throw new Error('MCP repair source or authorization changed; retry required');
    }
}

function refuseLocked(): never {
    throw new Error(LOCKED_MEMORY_MESSAGE);
}

// The opened transcript remains owned by the plan through preview, backup and
// commit. Callers must close it even on a dry run or a failed validation.
export async function planMcpRepair(
    store: MemoryStore,
    adapters: SessionAdapterMap,
    tool: ToolName,
    nativeId: string,
): Promise<McpRepairPlan> {
    const db = store.database;
    const readGeneration = withMemoryReadGeneration(db, refuseLocked, (token) => token);
    const sessions = db
        .prepare(`SELECT s.id, p.path AS project_path, s.source_path, s.segment_index FROM sessions s JOIN projects p ON p.id = s.project_id
            WHERE s.tool = ? AND s.native_id = ? ORDER BY s.id`)
        .all(tool, nativeId) as RepairSession[];
    const sourcePath = sessions[0]?.source_path;
    if (sourcePath === undefined || sessions.some((session) => session.source_path !== sourcePath)) {
        throw new Error('MCP repair requires one existing, unambiguous source transcript');
    }
    const adapter = sessionAdapterFor(adapters, tool);
    if (!adapter) {
        throw new Error('MCP repair requires a JSONL session adapter');
    }
    const opened = await openProviderTranscript(tool, sourcePath);
    if ('reason' in opened) {
        throw new Error(`MCP repair source unavailable: ${opened.reason}`);
    }
    const plan: McpRepairPlan = {
        tool,
        nativeId,
        sourcePath,
        sessions,
        memories: [],
        receipts: [],
        missingReceipts: [],
        readGeneration,
        generation: sourceGeneration(store, tool, nativeId),
        fingerprint: fingerprint(db, tool, nativeId),
        derived: new Map(
            sessions.map((session) => [
                session.id,
                {
                    renderedChars: 0,
                    renderedTurns: 0,
                    title: null,
                    firstPrompt: null,
                    lastTurnAt: null,
                    trailingBranch: null,
                    trailingFiles: [],
                    observed: 0,
                },
            ]),
        ),
        validateSource: sourceSnapshotValidator(tool, sourcePath, opened),
        close: () => opened.handle.close(),
    };
    try {
        assertAuthorized(store, plan);
        const ledger = new InjectionStore(db);
        const persistedCalls = new Set(ledger.mcpReceiptsForSession(tool, nativeId, plan.generation).map((receipt) => receipt.call_id));
        const sourceLedger = new InjectionStore(db, { includePersistedMcp: false });
        const lookup = db.prepare(`SELECT m.id, m.session_id, m.turn_index FROM memories m JOIN sessions s ON s.id = m.session_id
            WHERE s.tool = ? AND s.native_id = ? AND m.turn_index = ? ORDER BY m.id`);
        for await (const turn of adapter.parseTurns(opened.resolvedPath, undefined, { handle: opened.handle, closeTrailingOnIdle: true })) {
            if (turn.tool !== tool || turn.sessionId !== nativeId || !sessions.some((s) => s.project_path === turn.projectPath)) {
                throw new Error('MCP repair transcript identity does not match the stored session');
            }
            const stored = lookup.all(tool, nativeId, turn.turnIndex) as McpRepairPlan['memories'];
            if (turn.droppedReason !== 'elepha-mcp') {
                if (stored.length === 0) {
                    continue;
                }
                if (turn.droppedReason !== undefined || sourceLedger.isQuoteBackOrThrow(turn, 'MCP repair')) {
                    throw new Error(`MCP repair cannot reconstruct unrelated stored turn ${turn.turnIndex}`);
                }
                for (const memory of stored) {
                    const derived = derivedFor(plan, memory.session_id);
                    const rendered = renderRawTurn(turn, derived.renderedTurns + 1);
                    if (rendered !== null) {
                        derived.renderedChars += rendered.length + (derived.renderedTurns === 0 ? 1 : RAW_TURN_SEPARATOR.length);
                        derived.renderedTurns++;
                    }
                    derived.title = stripShellSyntax(
                        titleForTurn(derived.title, turn, sessions.find((s) => s.id === memory.session_id)?.segment_index === 0),
                    );
                    derived.firstPrompt ??= firstPromptSearch(turn.userMessage);
                    derived.lastTurnAt = turn.endedAt;
                    derived.trailingBranch = turn.gitBranch ?? derived.trailingBranch;
                    derived.trailingFiles = dedupePaths([
                        ...turn.toolCalls.flatMap((call) => call.filePaths),
                        ...derived.trailingFiles,
                    ]).slice(0, TRAILING_FILES_CAP);
                    derived.observed++;
                }
                continue;
            }
            turn.validateSource = plan.validateSource;
            if (!sourceLedger.rememberElephaMcpReceipts(turn) || !ledger.rememberElephaMcpReceipts(turn, plan.generation)) {
                throw new Error('MCP repair receipt protection incomplete');
            }
            plan.receipts.push(turn);
            for (const receipt of turn.elephaMcpResultReceipts ?? []) {
                if (!persistedCalls.has(receipt.callId)) {
                    plan.missingReceipts.push({ turnIndex: turn.turnIndex, callId: receipt.callId });
                    persistedCalls.add(receipt.callId);
                }
            }
            plan.memories.push(...stored);
        }
        if (!ledger.validateCompleteMcpReceiptLedger(tool, nativeId, plan.generation)) {
            throw new Error('MCP repair receipt ledger differs from source; source reconciliation required');
        }
        assertAuthorized(store, plan);
        if (fingerprint(db, tool, nativeId) !== plan.fingerprint) {
            throw new Error('MCP repair rows changed during preview');
        }
        for (const session of sessions) {
            const count = (db.prepare('SELECT COUNT(*) AS n FROM memories WHERE session_id = ?').get(session.id) as { n: number }).n;
            if (count !== derivedFor(plan, session.id).observed + plan.memories.filter((m) => m.session_id === session.id).length) {
                throw new Error('MCP repair source cannot reproduce all stored turn identities');
            }
        }
        return plan;
    } catch (error) {
        await plan.close();
        throw error;
    }
}

export function verifyMcpRepair(store: MemoryStore, plan: McpRepairPlan): void {
    const db = store.database;
    for (const memory of plan.memories) {
        if (db.prepare('SELECT 1 FROM memories WHERE id = ?').get(memory.id)) {
            throw new Error('MCP repair stale memory remains');
        }
    }
    const ledger = new InjectionStore(db);
    const rows = ledger.mcpReceiptsForSession(plan.tool, plan.nativeId, plan.generation);
    for (const turn of plan.receipts) {
        for (const receipt of turn.elephaMcpResultReceipts ?? []) {
            if (
                !rows.some((row) => row.call_id === receipt.callId && row.source_turn_index === turn.turnIndex && row.body === receipt.body)
            ) {
                throw new Error('MCP repair receipt verification failed');
            }
        }
    }
    if ((db.pragma('foreign_key_check') as unknown[]).length > 0) {
        throw new Error('MCP repair foreign key verification failed');
    }
}

export function applyMcpRepair(store: MemoryStore, plan: McpRepairPlan): void {
    const db = store.database;
    withMemoryReadGeneration(db, refuseLocked, () => undefined, plan.readGeneration);
    db.transaction(() => {
        if (!memoryReadAuthorityMatchesGenerationInTransaction(db, plan.readGeneration)) {
            refuseLocked();
        }
        assertAuthorized(store, plan);
        if (fingerprint(db, plan.tool, plan.nativeId) !== plan.fingerprint) {
            throw new Error('MCP repair rows changed after preview');
        }
        const firstSession = plan.sessions[0];
        if (
            !firstSession ||
            !store.publishElephaMcpReceiptBatch(plan.receipts, firstSession.id, plan.tool, plan.nativeId, plan.generation)
        ) {
            throw new Error('MCP repair receipt publication failed');
        }
        const affected = new Set(plan.memories.map((memory) => memory.session_id));
        for (const memory of plan.memories) {
            db.prepare('DELETE FROM memories WHERE id = ?').run(memory.id);
        }
        for (const id of affected) {
            // Durable text, FTS and usage cascade with each exact memory row.
            // The daemon rebuilds invalidated aggregates from the surviving rows.
            db.prepare('DELETE FROM session_embeddings WHERE session_id = ?').run(id);
            db.prepare('DELETE FROM session_rollups WHERE session_id = ?').run(id);
            db.prepare('DELETE FROM durable_capture_status WHERE session_id = ?').run(id);
            const derived = derivedFor(plan, id);
            db.prepare(`UPDATE sessions SET rendered_chars = ?, rendered_turns = ?,
                title = ?, first_prompt_search = ?, last_turn_at = ?,
                trailing_branch = ?, trailing_files = ? WHERE id = ?`).run(
                derived.renderedChars,
                derived.renderedTurns,
                derived.title,
                derived.firstPrompt,
                derived.lastTurnAt,
                derived.trailingBranch,
                JSON.stringify(derived.trailingFiles),
                id,
            );
        }
        assertAuthorized(store, plan);
        verifyMcpRepair(store, plan);
    }).immediate();
}
