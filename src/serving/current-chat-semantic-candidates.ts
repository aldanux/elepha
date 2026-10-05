import { statSync } from 'node:fs';
import type Database from 'better-sqlite3-multiple-ciphers';
import {
    CURRENT_CHAT_EVIDENCE_MAX_CANDIDATES,
    CURRENT_CHAT_EVIDENCE_MAX_CHARS,
    CURRENT_CHAT_EVIDENCE_MAX_ID_BYTES,
    CURRENT_CHAT_EVIDENCE_MAX_METADATA_PAGES,
    CURRENT_CHAT_EVIDENCE_MAX_PATH_BYTES,
    CURRENT_CHAT_EVIDENCE_MAX_QUERY_CHARS,
    CURRENT_CHAT_EVIDENCE_SEGMENT_PAGE,
    CURRENT_CHAT_SEMANTIC_DEADLINE_MS,
    CURRENT_CHAT_SEMANTIC_MAX_VECTOR_BYTES,
    CURRENT_CHAT_SEMANTIC_MAX_VECTOR_ROWS,
    DURABLE_CAPTURE_FILTER_VERSION,
} from '../config/constants.js';
import { canonicalizeExisting, samePath } from '../config/paths.js';
import { boundedEmbeddingText } from '../embeddings/generate-turns.js';
import { validateEmbedding } from '../embeddings/provider.js';
import { createEmbeddingProvider, type EmbeddingProvider, embeddingConfiguration } from '../embeddings/provider-config.js';
import { escapeShellSyntax } from '../security/sanitize.js';
import { gitRevParseShowToplevel } from '../security/subprocess-allowlist.js';
import { ConsentStore } from '../storage/consent-store.js';
import { retentionRemovedSql } from '../storage/live-memory-retention-schema.js';
import { ProjectResolver } from '../storage/project-resolver.js';
import {
    type CurrentChatSegment,
    readCurrentChatSegmentById,
    readCurrentChatSegmentPage,
    SERVED_SESSION_KIND_ELIGIBILITY,
} from '../storage/session-read-model.js';
import { TurnEmbeddingStore } from '../storage/turn-embedding-store.js';
import { TURN_EMBEDDINGS_TABLE } from '../storage/turn-embeddings.js';
import { TURN_SEARCH_INDEX_TABLE } from '../storage/turn-search-index.js';
import { SUPPORTED_TOOLS, type ToolName } from '../types/index.js';
import { SessionReader } from './session-reader.js';

export interface CurrentChatSemanticInput {
    tool: ToolName;
    nativeSessionId: string;
    cwd: string;
    query: string;
}

export interface CurrentChatSemanticCandidate {
    segmentIndex: number;
    turnIndex: number;
    similarity: number;
    evidenceSource: 'durable' | 'transcript';
    userPrompt: string;
    assistantResponse: string;
}

export type CurrentChatSemanticResult =
    | { state: 'available'; candidates: CurrentChatSemanticCandidate[]; partialCoverage: boolean; partialCoverageReason?: string }
    | { state: 'empty'; partialCoverage: false }
    | { state: 'unavailable'; reason: string };

interface VectorRow {
    memoryId: number;
    sessionId: number;
    projectId: number;
    turnIndex: number;
    sourceDigest: string;
    textHash: string;
    filterVersion: number;
    coverage: string;
    model: string;
    revision: string;
    dimensions: number;
    vector: Buffer;
}

const VECTOR_SELECT = `SELECT e.memory_id AS memoryId, m.session_id AS sessionId, m.project_id AS projectId,
    m.turn_index AS turnIndex, e.source_digest AS sourceDigest, e.text_hash AS textHash,
    tsi.filter_version AS filterVersion, tsi.coverage, e.model, e.model_revision AS revision,
    e.dimensions, e.vector
    FROM ${TURN_EMBEDDINGS_TABLE} e
    JOIN ${TURN_SEARCH_INDEX_TABLE} tsi ON tsi.memory_id = e.memory_id AND tsi.source_digest = e.source_digest
    JOIN memories m ON m.id = e.memory_id AND m.project_id = e.project_id
    JOIN sessions s ON s.id = m.session_id AND s.project_id = m.project_id
    WHERE m.session_id = ? AND e.model = ? AND e.model_revision = ? AND e.dimensions = ?
      AND length(e.vector) = ? AND length(e.text_hash) = 64 AND length(e.source_digest) = 64
      AND ${SERVED_SESSION_KIND_ELIGIBILITY}
      AND NOT EXISTS (SELECT 1 FROM purged_transcripts p WHERE p.tool = s.tool AND p.native_id = s.native_id) AND NOT ${retentionRemovedSql('s.tool', 's.native_id')}
      AND NOT EXISTS (SELECT 1 FROM incognito_transcripts i WHERE i.tool = s.tool AND i.native_id = s.native_id)`;

function physicalDirectory(path: string): string | undefined {
    try {
        return statSync(path).isDirectory() ? canonicalizeExisting(path) : undefined;
    } catch {
        return undefined;
    }
}

function anchor(path: string): string {
    return canonicalizeExisting(gitRevParseShowToplevel(path) ?? path);
}

async function beforeDeadline<T>(signal: AbortSignal, pending: Promise<T>): Promise<T> {
    if (signal.aborted) {
        void pending.catch(() => {});
        throw new Error('current_chat_semantic_deadline');
    }
    let onAbort: (() => void) | undefined;
    const cancelled = new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(new Error('current_chat_semantic_deadline'));
        signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
        return await Promise.race([pending, cancelled]);
    } finally {
        if (onAbort !== undefined) {
            signal.removeEventListener('abort', onAbort);
        }
    }
}

// This is an explicit candidate lookup. No similarity floor or automatic
// context selection is implied by a vector's rank.
async function readCurrentChatSemanticCandidates(
    db: Database.Database,
    input: CurrentChatSemanticInput,
    options: {
        configPath?: string;
        createProvider?: typeof createEmbeddingProvider;
        reader?: Pick<SessionReader, 'serveState' | 'indexedTurnEvidence'>;
        signal?: AbortSignal;
    } = {},
): Promise<CurrentChatSemanticResult> {
    const unavailable = (reason: string): CurrentChatSemanticResult => ({ state: 'unavailable', reason });
    if (
        !SUPPORTED_TOOLS.includes(input.tool) ||
        !input.nativeSessionId.trim() ||
        Buffer.byteLength(input.nativeSessionId, 'utf8') > CURRENT_CHAT_EVIDENCE_MAX_ID_BYTES ||
        Buffer.byteLength(input.cwd, 'utf8') > CURRENT_CHAT_EVIDENCE_MAX_PATH_BYTES ||
        !input.query.trim() ||
        input.query.length > CURRENT_CHAT_EVIDENCE_MAX_QUERY_CHARS
    ) {
        return unavailable('invalid_current_chat_semantic_request');
    }
    const store = new TurnEmbeddingStore(db, options.configPath);
    if (!store.enabled()) {
        return unavailable('memory_plus_disabled');
    }
    const reader = options.reader ?? new SessionReader(db);
    if (reader.serveState() === 'locked') {
        return unavailable('locked');
    }
    const consent = new ConsentStore(db);
    const physicalCwd = physicalDirectory(input.cwd);
    if (physicalCwd === undefined || consent.consentState(input.cwd) !== 'approved' || consent.isRefusedForCapture(input.cwd)) {
        return unavailable('checkout_not_consented');
    }
    const currentAnchor = anchor(physicalCwd);
    const deadlineAt = Date.now() + CURRENT_CHAT_SEMANTIC_DEADLINE_MS;
    const deadline = AbortSignal.timeout(CURRENT_CHAT_SEMANTIC_DEADLINE_MS);
    const signal = options.signal === undefined ? deadline : AbortSignal.any([options.signal, deadline]);
    const allowed = () => new Set(new ProjectResolver(db).listConsentedStored(consent).flatMap((project) => project.projectIds));
    const authorized = (segment: CurrentChatSegment, projectIds: ReadonlySet<number>): boolean => {
        if (
            segment.projectPath === null ||
            !projectIds.has(segment.projectId) ||
            consent.consentState(segment.projectPath) !== 'approved' ||
            consent.isRefusedForCapture(segment.projectPath)
        ) {
            return false;
        }
        const physical = physicalDirectory(segment.projectPath);
        return physical !== undefined && samePath(anchor(physical), currentAnchor);
    };
    const stillAllowed = (): boolean => {
        const physical = physicalDirectory(input.cwd);
        return (
            store.enabled() &&
            reader.serveState() !== 'locked' &&
            !signal.aborted &&
            Date.now() < deadlineAt &&
            physical !== undefined &&
            samePath(anchor(physical), currentAnchor) &&
            consent.consentState(input.cwd) === 'approved' &&
            !consent.isRefusedForCapture(input.cwd)
        );
    };
    const accessFailure = () => unavailable(signal.aborted || Date.now() >= deadlineAt ? 'deadline' : 'current_chat_authorization_changed');
    const segments: CurrentChatSegment[] = [];
    let before: number | null = null;
    let partialCoverageReason: string | undefined;
    for (let page = 0; page < CURRENT_CHAT_EVIDENCE_MAX_METADATA_PAGES; page++) {
        if (!stillAllowed()) {
            return accessFailure();
        }
        const rows = readCurrentChatSegmentPage(
            db,
            input.tool,
            input.nativeSessionId,
            CURRENT_CHAT_EVIDENCE_MAX_PATH_BYTES,
            before,
            CURRENT_CHAT_EVIDENCE_SEGMENT_PAGE,
        );
        segments.push(...rows);
        if (rows.length < CURRENT_CHAT_EVIDENCE_SEGMENT_PAGE) {
            break;
        }
        before = rows.at(-1)?.segmentIndex ?? null;
        if (
            page === CURRENT_CHAT_EVIDENCE_MAX_METADATA_PAGES - 1 &&
            readCurrentChatSegmentPage(db, input.tool, input.nativeSessionId, CURRENT_CHAT_EVIDENCE_MAX_PATH_BYTES, before, 1).length > 0
        ) {
            partialCoverageReason = 'older_segments_not_scanned';
        }
    }
    if (segments.length === 0) {
        return unavailable('current_chat_not_ingested');
    }
    const projectIds = allowed();
    const isSupportedFormat = (segment: CurrentChatSegment): boolean => {
        if (input.tool !== 'opencode') {
            return true;
        }
        const format = db.prepare('SELECT source_format FROM sessions WHERE id = ?').get(segment.id) as
            | { source_format: string }
            | undefined;
        return format?.source_format === 'opencode-v2';
    };
    const scoped = segments.filter((segment) => {
        if (!authorized(segment, projectIds)) {
            return false;
        }
        return isSupportedFormat(segment);
    });
    if (scoped.length === 0) {
        return unavailable('current_chat_checkout_mismatch');
    }
    const model = embeddingConfiguration(true);
    if (model?.provider !== 'local') {
        return unavailable('local_model_unavailable');
    }
    const vectors: Array<{ segment: CurrentChatSegment; row: VectorRow }> = [];
    let bytes = 0;
    for (const segment of scoped) {
        if (!stillAllowed()) {
            return accessFailure();
        }
        const remaining = CURRENT_CHAT_SEMANTIC_MAX_VECTOR_ROWS - vectors.length;
        if (remaining === 0) {
            partialCoverageReason ??= 'vector_scan_limit';
            break;
        }
        const rows = db
            .prepare(`${VECTOR_SELECT} ORDER BY m.turn_index DESC LIMIT ?`)
            .all(segment.id, model.model, model.revision, model.dimensions, model.dimensions * 4, remaining + 1) as VectorRow[];
        if (rows.length > remaining) {
            partialCoverageReason ??= 'vector_scan_limit';
        }
        for (const row of rows.slice(0, remaining)) {
            if (
                row.model !== model.model ||
                row.revision !== model.revision ||
                row.dimensions !== model.dimensions ||
                row.filterVersion !== DURABLE_CAPTURE_FILTER_VERSION ||
                !['included', 'truncated'].includes(row.coverage) ||
                !/^[a-f0-9]{64}$/.test(row.sourceDigest) ||
                !/^[a-f0-9]{64}$/.test(row.textHash) ||
                !Buffer.isBuffer(row.vector) ||
                row.vector.byteLength !== model.dimensions * 4
            ) {
                partialCoverageReason ??= 'stale_or_invalid_vectors';
                continue;
            }
            bytes += row.vector.byteLength;
            if (bytes > CURRENT_CHAT_SEMANTIC_MAX_VECTOR_BYTES) {
                partialCoverageReason ??= 'vector_byte_limit';
                break;
            }
            vectors.push({ segment, row });
        }
        if (bytes > CURRENT_CHAT_SEMANTIC_MAX_VECTOR_BYTES) {
            break;
        }
        if (segment.turnCount > rows.length) {
            partialCoverageReason ??= 'turn_vectors_missing';
        }
    }
    if (vectors.length === 0) {
        return partialCoverageReason ? unavailable(partialCoverageReason) : { state: 'empty', partialCoverage: false };
    }
    let provider: EmbeddingProvider | undefined;
    let creating: Promise<EmbeddingProvider | undefined> | undefined;
    let queryVector: number[];
    try {
        creating = (options.createProvider ?? createEmbeddingProvider)(true);
        provider = await beforeDeadline(signal, creating);
        if (
            provider?.configuration.provider !== 'local' ||
            provider.configuration.model !== model.model ||
            provider.configuration.revision !== model.revision ||
            provider.configuration.dimensions !== model.dimensions
        ) {
            return unavailable('local_model_changed');
        }
        if (!stillAllowed()) {
            return accessFailure();
        }
        // The deadline bounds this lookup's response latency. The local model
        // may continue inference until its next beforeUse checkpoint.
        queryVector = await beforeDeadline(
            signal,
            provider.embed(
                escapeShellSyntax(input.query.trim()),
                () => {
                    if (!stillAllowed()) {
                        throw new Error('current_chat_authorization_changed');
                    }
                },
                'query',
            ),
        );
        validateEmbedding(queryVector, model.dimensions);
    } catch {
        if (provider === undefined && signal.aborted && creating !== undefined) {
            // A timed-out local model load can still finish; release that late provider.
            void creating.then((late) => late?.dispose()).catch(() => {});
        }
        return stillAllowed() ? unavailable('query_embedding_unavailable') : accessFailure();
    } finally {
        if (provider !== undefined) {
            try {
                await beforeDeadline(signal, provider.dispose());
            } catch {
                // Disposal is best-effort; the authorization check below still gates output.
            }
        }
    }
    if (!stillAllowed()) {
        return accessFailure();
    }
    const norm = Math.hypot(...queryVector);
    const ranked = vectors
        .flatMap(({ segment, row }) => {
            const vector = Array.from({ length: model.dimensions }, (_, index) => row.vector.readFloatLE(index * 4));
            if (vector.some((value) => !Number.isFinite(value))) {
                partialCoverageReason ??= 'stale_or_invalid_vectors';
                return [];
            }
            const magnitude = Math.hypot(...vector);
            if (magnitude === 0) {
                partialCoverageReason ??= 'stale_or_invalid_vectors';
                return [];
            }
            const similarity = Math.max(
                -1,
                Math.min(1, vector.reduce((sum, value, index) => sum + value * queryVector[index], 0) / (norm * magnitude)),
            );
            return [{ segment, row, similarity }];
        })
        .sort(
            (a, b) => b.similarity - a.similarity || b.segment.segmentIndex - a.segment.segmentIndex || b.row.turnIndex - a.row.turnIndex,
        );
    const candidates: CurrentChatSemanticCandidate[] = [];
    const selected: Array<{ segment: CurrentChatSegment; row: VectorRow }> = [];
    let evidenceChars = 0;
    for (const hit of ranked) {
        if (candidates.length >= CURRENT_CHAT_EVIDENCE_MAX_CANDIDATES) {
            partialCoverageReason ??= 'candidate_limit';
            break;
        }
        if (!stillAllowed()) {
            return accessFailure();
        }
        const current = readCurrentChatSegmentById(
            db,
            input.tool,
            input.nativeSessionId,
            CURRENT_CHAT_EVIDENCE_MAX_PATH_BYTES,
            hit.segment.id,
        );
        if (
            !current ||
            current.source_path !== hit.segment.source_path ||
            !authorized(current, allowed()) ||
            !isSupportedFormat(current) ||
            !current.projectPath ||
            !current.source_path
        ) {
            return accessFailure();
        }
        const fresh = db
            .prepare(`${VECTOR_SELECT} AND e.memory_id = ?`)
            .get(current.id, model.model, model.revision, model.dimensions, model.dimensions * 4, hit.row.memoryId) as
            | VectorRow
            | undefined;
        if (
            !fresh ||
            fresh.sourceDigest !== hit.row.sourceDigest ||
            fresh.textHash !== hit.row.textHash ||
            fresh.model !== hit.row.model ||
            fresh.revision !== hit.row.revision ||
            !fresh.vector.equals(hit.row.vector)
        ) {
            partialCoverageReason ??= 'stale_or_invalid_vectors';
            continue;
        }
        const evidence = await reader.indexedTurnEvidence(
            {
                id: current.id,
                tool: input.tool,
                native_id: input.nativeSessionId,
                source_path: current.source_path,
                expectedProjectPath: current.projectPath,
            },
            hit.row.turnIndex,
            signal,
        );
        if (!stillAllowed()) {
            return accessFailure();
        }
        if (evidence.state !== 'available') {
            partialCoverageReason ??= evidence.reason;
            continue;
        }
        const projection = evidence.projection;
        const hash = boundedEmbeddingText(
            projection.userPrompt,
            projection.assistantResponse,
            projection.filterVersion,
            hit.row.sourceDigest,
        ).hash;
        if (!projection.included || projection.filterVersion !== hit.row.filterVersion || hash !== hit.row.textHash) {
            partialCoverageReason ??= 'stale_or_invalid_vectors';
            continue;
        }
        const userPrompt = escapeShellSyntax(projection.userPrompt);
        const assistantResponse = escapeShellSyntax(projection.assistantResponse);
        const length = userPrompt.length + assistantResponse.length;
        if (evidenceChars + length > CURRENT_CHAT_EVIDENCE_MAX_CHARS) {
            partialCoverageReason ??= 'evidence_char_limit';
            continue;
        }
        evidenceChars += length;
        candidates.push({
            segmentIndex: current.segmentIndex,
            turnIndex: hit.row.turnIndex,
            similarity: hit.similarity,
            // Source identity is established by SessionReader at the evidence read.
            evidenceSource: evidence.source,
            userPrompt,
            assistantResponse,
        });
        selected.push(hit);
    }
    if (!stillAllowed()) {
        return accessFailure();
    }
    if (candidates.length === 0) {
        return unavailable(partialCoverageReason ?? 'indexed_turn_evidence_unavailable');
    }
    const finalProjectIds = allowed();
    for (const hit of selected) {
        const current = readCurrentChatSegmentById(
            db,
            input.tool,
            input.nativeSessionId,
            CURRENT_CHAT_EVIDENCE_MAX_PATH_BYTES,
            hit.segment.id,
        );
        const fresh = db
            .prepare(`${VECTOR_SELECT} AND e.memory_id = ?`)
            .get(hit.segment.id, model.model, model.revision, model.dimensions, model.dimensions * 4, hit.row.memoryId) as
            | VectorRow
            | undefined;
        if (
            !current ||
            !authorized(current, finalProjectIds) ||
            !isSupportedFormat(current) ||
            current.source_path !== hit.segment.source_path ||
            !fresh ||
            fresh.sourceDigest !== hit.row.sourceDigest ||
            fresh.textHash !== hit.row.textHash ||
            fresh.model !== hit.row.model ||
            fresh.revision !== hit.row.revision ||
            !fresh.vector.equals(hit.row.vector)
        ) {
            return accessFailure();
        }
    }
    return {
        state: 'available',
        candidates,
        partialCoverage: partialCoverageReason !== undefined,
        ...(partialCoverageReason ? { partialCoverageReason } : {}),
    };
}

export async function currentChatSemanticCandidates(
    db: Database.Database,
    input: CurrentChatSemanticInput,
    options: Parameters<typeof readCurrentChatSemanticCandidates>[2] = {},
): Promise<CurrentChatSemanticResult> {
    try {
        return await readCurrentChatSemanticCandidates(db, input, options);
    } catch {
        return { state: 'unavailable', reason: 'current_chat_semantic_error' };
    }
}
