import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3-multiple-ciphers';
import { sessionAdapterFor } from '../adapters/index.js';
import { decodeAssistantStructure } from '../rendering/assistant-structure.js';
import { openProviderTranscript } from '../security/provider-transcript.js';
import type { SessionAdapterMap } from '../types/index.js';
import { InjectionStore } from './injection-store.js';
import {
    assertRepairAuthorized,
    type DerivedSession,
    derivedFor,
    emptyDerivedSessions,
    invalidateRepairedSession,
    observeSurvivingTurn,
    type RepairSession,
    refuseLocked,
    repairFingerprint,
} from './mcp-repair.js';
import type { MemoryStore } from './memory-store.js';
import {
    type AuthenticatedReadGeneration,
    memoryReadAuthorityMatchesGenerationInTransaction,
    withMemoryReadGeneration,
} from './paranoid-gate.js';
import { sourceGeneration, sourceSnapshotValidator } from './source-reconciliation.js';

const TOOL = 'claude-code';
const LABEL = 'Compact summary repair';

export interface CompactRepairMemory {
    id: number;
    session_id: number;
    turn_index: number;
}

export interface CompactSummaryRepairPlan {
    tool: typeof TOOL;
    nativeId: string;
    sourcePath: string;
    sessions: RepairSession[];
    // Rows whose source turn is a compact summary with nothing after it.
    memories: CompactRepairMemory[];
    // Rows at an automatic-compact continuation. Earlier parses folded the
    // summary into this genuine turn, so its stored text may carry it, but
    // the row itself is real work: reported, never changed here.
    unresolved: CompactRepairMemory[];
    readGeneration: AuthenticatedReadGeneration;
    generation: number;
    fingerprint: string;
    survivors: string;
    derived: Map<number, DerivedSession>;
    validateSource: () => boolean;
    close: () => Promise<void>;
}

interface StoredCompactCandidate extends CompactRepairMemory {
    turn_started_at: string;
    durable_id: number | null;
    user_prompt: string | null;
    assistant_response: string | null;
    assistant_structure: string | null;
    tool_calls: string | null;
    omitted_tool_call_count: number | null;
    dropped_tool_ref_count: number | null;
    omitted_before_chars: number | null;
}

// A summary-only turn carried no assistant work, so its durable copy, when
// one exists, must hold none either: the source proves the turn is empty,
// but a durable copy may be the only record of what an older parse stored.
// Values are compared against exactly what capture writes for an empty
// assistant side; anything else is ambiguous and keeps the row.
function durableCopyHoldsNoAssistantWork(row: StoredCompactCandidate): boolean {
    if (row.durable_id === null) {
        return true;
    }
    if (row.assistant_response !== '' || row.tool_calls !== '[]' || row.omitted_tool_call_count !== 0 || row.dropped_tool_ref_count !== 0) {
        return false;
    }
    // Capture bounds the oldest end first, in prompt, response, tool order,
    // so response text or a tool can be evicted only after the whole prompt
    // was. A retained prompt proves omitted characters were prompt text.
    if (row.omitted_before_chars !== 0 && row.user_prompt === '') {
        return false;
    }
    if (row.assistant_structure === null) {
        return true;
    }
    try {
        // Against an empty response any final-answer span is invalid, so a
        // decoded structure can only still signal omitted finals.
        return decodeAssistantStructure(row.assistant_structure, 0)?.omitted === 0;
    } catch {
        return false;
    }
}

// Binds every memory and durable copy the repair must leave untouched, so
// verification can prove the delete removed exactly the planned rows.
function survivorDigest(db: Database.Database, nativeId: string, removed: ReadonlySet<number>): string {
    const hash = createHash('sha256');
    const rows = db
        .prepare(`SELECT m.*, f.* FROM memories m JOIN sessions s ON s.id = m.session_id
            LEFT JOIN filtered_turns f ON f.memory_id = m.id WHERE s.tool = ? AND s.native_id = ? ORDER BY m.id`)
        .iterate(TOOL, nativeId) as Iterable<{ id: number }>;
    for (const row of rows) {
        if (!removed.has(row.id)) {
            hash.update(JSON.stringify(row));
        }
    }
    return hash.digest('hex');
}

// Selects only rows the current adapter structurally proves were a compact
// summary with no continuation: the flag, the dropped-empty shape and the
// stored start time all come from the source, never from wording. Any stored
// turn the source cannot reproduce aborts the plan instead of guessing.
// The opened transcript remains owned by the plan through preview, backup and
// commit. Callers must close it even on a dry run or a failed validation.
export async function planCompactSummaryRepair(
    store: MemoryStore,
    adapters: SessionAdapterMap,
    nativeId: string,
): Promise<CompactSummaryRepairPlan> {
    const db = store.database;
    const readGeneration = withMemoryReadGeneration(db, refuseLocked, (token) => token);
    const sessions = db
        .prepare(`SELECT s.id, p.path AS project_path, s.source_path, s.segment_index FROM sessions s JOIN projects p ON p.id = s.project_id
            WHERE s.tool = ? AND s.native_id = ? ORDER BY s.id`)
        .all(TOOL, nativeId) as RepairSession[];
    const sourcePath = sessions[0]?.source_path;
    if (sourcePath === undefined || sessions.some((session) => session.source_path !== sourcePath)) {
        throw new Error(`${LABEL} requires one existing, unambiguous source transcript`);
    }
    const adapter = sessionAdapterFor(adapters, TOOL);
    if (!adapter) {
        throw new Error(`${LABEL} requires a JSONL session adapter`);
    }
    const opened = await openProviderTranscript(TOOL, sourcePath);
    if ('reason' in opened) {
        throw new Error(`${LABEL} source unavailable: ${opened.reason}`);
    }
    const plan: CompactSummaryRepairPlan = {
        tool: TOOL,
        nativeId,
        sourcePath,
        sessions,
        memories: [],
        unresolved: [],
        readGeneration,
        generation: sourceGeneration(store, TOOL, nativeId),
        fingerprint: repairFingerprint(db, TOOL, nativeId),
        survivors: '',
        derived: emptyDerivedSessions(sessions),
        validateSource: sourceSnapshotValidator(TOOL, sourcePath, opened),
        close: () => opened.handle.close(),
    };
    try {
        assertRepairAuthorized(store, plan, LABEL);
        const sourceLedger = new InjectionStore(db, { includePersistedMcp: false });
        const lookup = db.prepare(`SELECT m.id, m.session_id, m.turn_index, m.turn_started_at, f.memory_id AS durable_id, f.user_prompt,
            f.assistant_response, f.assistant_structure, f.tool_calls, f.omitted_tool_call_count, f.dropped_tool_ref_count,
            f.omitted_before_chars FROM memories m JOIN sessions s ON s.id = m.session_id LEFT JOIN filtered_turns f ON f.memory_id = m.id
            WHERE s.tool = ? AND s.native_id = ? AND m.turn_index = ? ORDER BY m.id`);
        for await (const turn of adapter.parseTurns(opened.resolvedPath, undefined, { handle: opened.handle, closeTrailingOnIdle: true })) {
            if (turn.tool !== TOOL || turn.sessionId !== nativeId || !sessions.some((s) => s.project_path === turn.projectPath)) {
                //noinspection ExceptionCaughtLocallyJS
                throw new Error(`${LABEL} transcript identity does not match the stored session`);
            }
            const stored = lookup.all(TOOL, nativeId, turn.turnIndex) as StoredCompactCandidate[];
            if (turn.droppedReason === 'elepha-mcp') {
                if (!sourceLedger.rememberElephaMcpReceipts(turn)) {
                    //noinspection ExceptionCaughtLocallyJS
                    throw new Error(`${LABEL} receipt protection incomplete`);
                }
                if (stored.length > 0) {
                    //noinspection ExceptionCaughtLocallyJS
                    throw new Error(`${LABEL} found a stored Elepha MCP turn ${turn.turnIndex}; run repair-mcp-self-ingestion first`);
                }
                continue;
            }
            if (stored.length === 0) {
                continue;
            }
            if (
                turn.formerlyStoredBoundary === true &&
                turn.droppedReason === 'empty' &&
                turn.userMessage === '' &&
                turn.assistantText === '' &&
                turn.toolCalls.length === 0
            ) {
                // The old parse opened this turn on the same summary line, so
                // its stored start time is that line's; anything else is a
                // different row that happens to share the index.
                if (stored.some((row) => row.turn_started_at !== turn.startedAt)) {
                    //noinspection ExceptionCaughtLocallyJS
                    throw new Error(`${LABEL} cannot bind stored turn ${turn.turnIndex} to its compact summary`);
                }
                if (!stored.every(durableCopyHoldsNoAssistantWork)) {
                    //noinspection ExceptionCaughtLocallyJS
                    throw new Error(
                        `${LABEL} refuses stored turn ${turn.turnIndex}: its durable copy may hold assistant work the summary-only source turn cannot account for`,
                    );
                }
                plan.memories.push(...stored.map(({ id, session_id, turn_index }) => ({ id, session_id, turn_index })));
                continue;
            }
            if (turn.droppedReason !== undefined || sourceLedger.isQuoteBackOrThrow(turn, LABEL)) {
                //noinspection ExceptionCaughtLocallyJS
                throw new Error(`${LABEL} cannot reconstruct unrelated stored turn ${turn.turnIndex}`);
            }
            if (turn.formerlyStoredBoundary === true) {
                plan.unresolved.push(...stored.map(({ id, session_id, turn_index }) => ({ id, session_id, turn_index })));
            }
            for (const memory of stored) {
                observeSurvivingTurn(
                    derivedFor(plan, memory.session_id, LABEL),
                    turn,
                    sessions.find((s) => s.id === memory.session_id)?.segment_index === 0,
                );
            }
        }
        assertRepairAuthorized(store, plan, LABEL);
        if (repairFingerprint(db, TOOL, nativeId) !== plan.fingerprint) {
            //noinspection ExceptionCaughtLocallyJS
            throw new Error(`${LABEL} rows changed during preview`);
        }
        for (const session of sessions) {
            const count = (db.prepare('SELECT COUNT(*) AS n FROM memories WHERE session_id = ?').get(session.id) as { n: number }).n;
            if (count !== derivedFor(plan, session.id, LABEL).observed + plan.memories.filter((m) => m.session_id === session.id).length) {
                //noinspection ExceptionCaughtLocallyJS
                throw new Error(`${LABEL} source cannot reproduce all stored turn identities`);
            }
        }
        plan.survivors = survivorDigest(db, nativeId, new Set(plan.memories.map((memory) => memory.id)));
        return plan;
    } catch (error) {
        await plan.close();
        throw error;
    }
}

export function verifyCompactSummaryRepair(store: MemoryStore, plan: CompactSummaryRepairPlan): void {
    const db = store.database;
    const exists = db.prepare('SELECT 1 FROM memories WHERE id = ?');
    for (const memory of plan.memories) {
        if (exists.get(memory.id)) {
            throw new Error(`${LABEL} verification failed: summary-only memory remains`);
        }
    }
    for (const memory of plan.unresolved) {
        if (!exists.get(memory.id)) {
            throw new Error(`${LABEL} verification failed: continuation memory removed`);
        }
    }
    if (survivorDigest(db, plan.nativeId, new Set(plan.memories.map((memory) => memory.id))) !== plan.survivors) {
        throw new Error(`${LABEL} verification failed: surviving memories changed`);
    }
    const count = db.prepare('SELECT COUNT(*) AS n FROM memories WHERE session_id = ?');
    for (const id of new Set(plan.memories.map((memory) => memory.session_id))) {
        if ((count.get(id) as { n: number }).n !== derivedFor(plan, id, LABEL).observed) {
            throw new Error(`${LABEL} verification failed: surviving turn count differs from source`);
        }
    }
    if ((db.pragma('foreign_key_check') as unknown[]).length > 0) {
        throw new Error(`${LABEL} foreign key verification failed`);
    }
}

export function applyCompactSummaryRepair(store: MemoryStore, plan: CompactSummaryRepairPlan): void {
    const db = store.database;
    withMemoryReadGeneration(db, refuseLocked, () => undefined, plan.readGeneration);
    db.transaction(() => {
        if (!memoryReadAuthorityMatchesGenerationInTransaction(db, plan.readGeneration)) {
            refuseLocked();
        }
        assertRepairAuthorized(store, plan, LABEL);
        if (repairFingerprint(db, plan.tool, plan.nativeId) !== plan.fingerprint) {
            throw new Error(`${LABEL} rows changed after preview`);
        }
        const remove = db.prepare('DELETE FROM memories WHERE id = ? AND session_id = ? AND turn_index = ?');
        for (const memory of plan.memories) {
            if (remove.run(memory.id, memory.session_id, memory.turn_index).changes !== 1) {
                throw new Error(`${LABEL} rows changed after preview`);
            }
        }
        for (const id of new Set(plan.memories.map((memory) => memory.session_id))) {
            invalidateRepairedSession(db, id, derivedFor(plan, id, LABEL));
        }
        assertRepairAuthorized(store, plan, LABEL);
        verifyCompactSummaryRepair(store, plan);
    }).immediate();
}
