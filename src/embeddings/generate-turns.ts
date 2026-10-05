// Offline-only turn vector generation. The isolated refresh worker uses this;
// hooks and the daemon ingestion loop do not.

import { createHash } from 'node:crypto';
import type { Database } from 'better-sqlite3-multiple-ciphers';
import { TURN_EMBEDDING_MAX_TEXT_CHARS, TURN_EMBEDDING_PAGE_SIZE, TURN_EMBEDDING_PASS_MAX_ROWS } from '../config/constants.js';
import { stripShellSyntax } from '../security/sanitize.js';
import { SessionReader } from '../serving/session-reader.js';
import { lockedEmbedding } from '../storage/embedding-store.js';
import { withMemoryReadGeneration } from '../storage/paranoid-gate.js';

import { TurnEmbeddingSourceChangedError, TurnEmbeddingStore } from '../storage/turn-embedding-store.js';
import { errorMessage } from '../util/error.js';
import { createEmbeddingProvider, type EmbeddingModel, type EmbeddingProvider, embeddingConfiguration } from './provider-config.js';

export interface TurnEmbeddingGenerationResult {
    disabled: boolean;
    generated: number;
    current: number;
    sourceChanged: number;
    unavailable: number;
    failed: number;
    scanned: number;
    truncated: boolean;
    issueKeys: string[];
    nextCursor?: TurnEmbeddingCursor;
}

export interface TurnEmbeddingCursor {
    beforeMemoryId: number;
    model: string;
    revision: string;
    dimensions: number;
}

type TurnEvidenceReader = Pick<SessionReader, 'indexedTurnEvidence'>;

export function boundedEmbeddingText(
    userPrompt: string,
    assistantResponse: string,
    filterVersion: number,
    sourceDigest: string,
): { text: string; hash: string } {
    const sanitized = stripShellSyntax(`user:\n${userPrompt}\nassistant:\n${assistantResponse}`);
    let omitted = Math.max(0, sanitized.length - TURN_EMBEDDING_MAX_TEXT_CHARS);
    if (omitted > 0 && /[\uDC00-\uDFFF]/.test(sanitized.charAt(omitted))) {
        omitted++;
    }
    // Cutting at the newest-end boundary can expose a formerly mid-line
    // operator; sanitize again after slicing without increasing the length.
    const text = stripShellSyntax(sanitized.slice(omitted));
    const hash = createHash('sha256')
        .update(JSON.stringify([sourceDigest, filterVersion, omitted, text]), 'utf8')
        .digest('hex');
    return { text, hash };
}

function changedReason(reason: string): boolean {
    return (
        reason === 'indexed_turn_source_changed' ||
        reason === 'indexed_turn_filter_version_mismatch' ||
        reason === 'transcript_identity_mismatch'
    );
}

function authorizationReason(reason: string): boolean {
    return (
        reason === 'locked' ||
        reason === 'checkout_not_consented' ||
        reason === 'checkout_identity_changed' ||
        reason === 'indexed_turn_authorization_changed'
    );
}

function requireMatchingLocalProvider(provider: EmbeddingProvider | undefined, model: EmbeddingModel): EmbeddingProvider {
    if (provider?.configuration.provider !== 'local') {
        throw new Error('Turn embeddings require the local Memory-Plus provider.');
    }
    if (
        provider.configuration.model !== model.model ||
        provider.configuration.revision !== model.revision ||
        provider.configuration.dimensions !== model.dimensions
    ) {
        throw new Error('Turn embedding provider configuration changed.');
    }
    return provider;
}

function requireEvidenceAuthorization(reason: string): void {
    if (authorizationReason(reason)) {
        throw new TurnEmbeddingSourceChangedError();
    }
}

export async function generateTurnEmbeddings(
    db: Database,
    options: {
        configPath?: string;
        createProvider?: typeof createEmbeddingProvider;
        reader?: TurnEvidenceReader;
        cursor?: TurnEmbeddingCursor;
        progress?: () => void;
        maxRows?: number;
    } = {},
): Promise<TurnEmbeddingGenerationResult> {
    const result: TurnEmbeddingGenerationResult = {
        disabled: false,
        generated: 0,
        current: 0,
        sourceChanged: 0,
        unavailable: 0,
        failed: 0,

        scanned: 0,
        truncated: false,
        issueKeys: [],
    };
    const store = new TurnEmbeddingStore(db, options.configPath);
    const maxRows = options.maxRows ?? TURN_EMBEDDING_PASS_MAX_ROWS;
    if (!Number.isSafeInteger(maxRows) || maxRows < 1 || maxRows > TURN_EMBEDDING_PASS_MAX_ROWS) {
        throw new Error('Invalid turn embedding pass size.');
    }
    if (!store.enabled()) {
        return { ...result, disabled: true };
    }
    const generation = withMemoryReadGeneration(db, lockedEmbedding, (token) => token);
    const model = embeddingConfiguration(true);
    if (model?.provider !== 'local') {
        throw new Error('Turn embeddings require the local Memory-Plus provider.');
    }
    const reader = options.reader ?? new SessionReader(db);
    let provider: EmbeddingProvider | undefined;
    // A caller carries this cursor only while finishing the same model sweep.
    // A revision change restarts at the newest row so stale vectors are not skipped.
    const cursor = options.cursor;
    let before =
        cursor !== undefined &&
        Number.isSafeInteger(cursor.beforeMemoryId) &&
        cursor.beforeMemoryId > 0 &&
        cursor.model === model.model &&
        cursor.revision === model.revision &&
        cursor.dimensions === model.dimensions
            ? cursor.beforeMemoryId
            : Number.MAX_SAFE_INTEGER;
    try {
        while (result.scanned < maxRows) {
            options.progress?.();
            const remaining = maxRows - result.scanned;
            const pageSize = Math.min(TURN_EMBEDDING_PAGE_SIZE, remaining);
            const rows = store.page(before, pageSize + 1, generation);
            if (rows.length === 0) {
                break;
            }
            for (const candidate of rows.slice(0, pageSize)) {
                options.progress?.();
                before = candidate.memoryId;
                result.scanned++;
                try {
                    if (
                        candidate.native_id === null ||
                        candidate.source_path === null ||
                        candidate.projectPath === null ||
                        candidate.sourceDigest === null
                    ) {
                        result.unavailable++;
                        result.issueKeys.push(`unavailable:${candidate.memoryId}`);
                        continue;
                    }
                    store.assertCurrent(candidate, generation);
                    const evidence = await reader.indexedTurnEvidence(
                        {
                            id: candidate.sessionId,
                            tool: candidate.tool,
                            native_id: candidate.native_id,
                            source_path: candidate.source_path,
                            expectedProjectPath: candidate.projectPath,
                        },
                        candidate.turnIndex,
                    );
                    options.progress?.();
                    if (evidence.state === 'unavailable') {
                        requireEvidenceAuthorization(evidence.reason);
                        if (candidate.reingested !== 0 || changedReason(evidence.reason)) {
                            result.sourceChanged++;
                            result.issueKeys.push(`changed:${candidate.memoryId}`);
                        } else {
                            result.unavailable++;
                            result.issueKeys.push(`unavailable:${candidate.memoryId}`);
                        }
                        continue;
                    }
                    if (
                        evidence.turnIndex !== candidate.turnIndex ||
                        evidence.projection.filterVersion !== candidate.filterVersion ||
                        !evidence.projection.included
                    ) {
                        result.sourceChanged++;
                        result.issueKeys.push(`changed:${candidate.memoryId}`);
                        continue;
                    }
                    // Reingest refreshes the index digest but does not recapture
                    // the older durable row. Only transcript replay can prove its
                    // text now; never stamp that old durable text with a new digest.
                    if (evidence.source === 'durable' && candidate.reingested !== 0) {
                        result.sourceChanged++;
                        result.issueKeys.push(`changed:${candidate.memoryId}`);
                        continue;
                    }
                    const { text, hash } = boundedEmbeddingText(
                        evidence.projection.userPrompt,
                        evidence.projection.assistantResponse,
                        evidence.projection.filterVersion,
                        candidate.sourceDigest,
                    );
                    if (!text.trim()) {
                        result.unavailable++;
                        result.issueKeys.push(`unavailable:${candidate.memoryId}`);
                        continue;
                    }
                    if (store.current(candidate, hash, model, generation)) {
                        result.current++;
                        continue;
                    }
                    provider ??= await (options.createProvider ?? createEmbeddingProvider)(true);
                    options.progress?.();
                    provider = requireMatchingLocalProvider(provider, model);
                    const check = () => {
                        options.progress?.();
                        store.assertCurrent(candidate, generation);
                    };
                    const vector = await provider.embed(text, check, 'passage');
                    options.progress?.();
                    store.write(candidate, hash, model, vector, generation);
                    result.generated++;
                } catch (error) {
                    // A stopped worker must abort the pass, not count its own
                    // cancellation as a failed source and advance the cursor.
                    options.progress?.();
                    store.assertCurrent(candidate, generation);
                    if (error instanceof TurnEmbeddingSourceChangedError) {
                        throw error;
                    }

                    throw new Error(`Turn ${candidate.memoryId}: ${errorMessage(error)} (turn indexing pass aborted).`, { cause: error });
                }
            }
            if (rows.length > pageSize && result.scanned >= maxRows) {
                result.truncated = true;
                result.nextCursor = {
                    beforeMemoryId: before,
                    model: model.model,
                    revision: model.revision,
                    dimensions: model.dimensions,
                };
            }
        }
        return result;
    } finally {
        await provider?.dispose();
    }
}
