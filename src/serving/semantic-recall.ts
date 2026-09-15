import type { Database } from 'better-sqlite3-multiple-ciphers';
import { SEMANTIC_RECALL_MAX_HITS, SEMANTIC_SCAN_BUDGET_MS, SEMANTIC_SCAN_MAX_ROWS } from '../config/constants.js';
import { getSetting } from '../config/settings.js';
import type { createEmbeddingProvider } from '../embeddings/provider-config.js';
import { escapeShellSyntax } from '../security/sanitize.js';
import { ConsentStore } from '../storage/consent-store.js';
import type { EmbeddingScanTruncation } from '../storage/embedding-store.js';
import { LOCKED_CONTENT_COVERAGE, LOCKED_MEMORY_MESSAGE, withMemoryReadGeneration } from '../storage/paranoid-gate.js';
import { ProjectResolver, type ProjectSet } from '../storage/project-resolver.js';
import { readEligibleEmbeddingSessionIds, readEmbeddingSession } from '../storage/session-read-model.js';
import { hitIdentity, type LexicalRecallResult, type RecallQuery, type RecallScope, renderRecallBody } from './lexical-recall.js';

export interface SemanticCandidate {
    sessionId: number;
    similarity: number;
}

export interface SemanticRecallResult {
    candidates: SemanticCandidate[];
    truncation?: EmbeddingScanTruncation;
    hitCapOmittedSessionIds?: number[];
}

export function semanticScanTruncation(reason: EmbeddingScanTruncation): string {
    const budget = reason === 'rows' ? `${SEMANTIC_SCAN_MAX_ROWS} indexed rows` : `${SEMANTIC_SCAN_BUDGET_MS} ms`;
    return `Partial semantic search: older stored sessions omitted after the ${budget} scan budget; more matches may exist.`;
}

export function semanticHitCapTruncation(omitted: number): string {
    return `Partial semantic search: ${omitted} compatible semantic matches omitted by the ${SEMANTIC_RECALL_MAX_HITS}-hit cap; lowest similarities dropped first, oldest stored sessions first on ties.`;
}

export function semanticRecallNotices(
    result: SemanticRecallResult,
    displayedIds: readonly number[] = result.candidates.map((candidate) => candidate.sessionId),
): string | undefined {
    const displayed = new Set(displayedIds);
    const omitted = result.hitCapOmittedSessionIds?.filter((id) => !displayed.has(id)).length ?? 0;
    return (
        [
            result.truncation === undefined ? undefined : semanticScanTruncation(result.truncation),
            omitted ? semanticHitCapTruncation(omitted) : undefined,
        ]
            .filter((notice) => notice !== undefined)
            .join('\n') || undefined
    );
}

export const SEMANTIC_DISCOVERY = 'Found by semantic similarity';

export function semanticDiscovery(similarity: number): string {
    return `${SEMANTIC_DISCOVERY} (cosine ${similarity.toFixed(3)})`;
}

export async function semanticRecall(
    db: Database,
    projectIds: readonly number[],
    query: string,
    options: {
        configPath?: string;
        createProvider?: typeof createEmbeddingProvider;
        beforeUse?: () => void;
        // Strict floor for automatic recall; explicit search keeps all similarities.
        minSimilarity?: number;
    } = {},
): Promise<SemanticRecallResult> {
    // Keep all embedding imports, provider configuration and vector reads behind
    // the opt-in. Checking the setting itself never loads the optional runtime.
    if (!getSetting('memory-plus', {}, options.configPath).value || projectIds.length === 0 || !query.trim()) {
        return { candidates: [] };
    }
    const { EmbeddingStore, lockedEmbedding, MEMORY_PLUS_DISABLED } = await import('../storage/embedding-store.js');
    const { createEmbeddingProvider } = await import('../embeddings/provider-config.js');
    const validateEmbedding: typeof import('../embeddings/provider.js').validateEmbedding = (await import('../embeddings/provider.js'))
        .validateEmbedding;
    const generation = withMemoryReadGeneration(db, lockedEmbedding, (token) => token);
    const store = new EmbeddingStore(db, options.configPath);
    const check = () => {
        options.beforeUse?.();
        return withMemoryReadGeneration(db, lockedEmbedding, () => store.assertEnabled(), generation);
    };
    check();
    const provider = await (options.createProvider ?? createEmbeddingProvider)(true);
    if (provider === undefined) {
        throw new Error(MEMORY_PLUS_DISABLED);
    }
    let queryVector: number[];
    try {
        check();
        queryVector = await provider.embed(escapeShellSyntax(query), check, 'query');
    } finally {
        await provider.dispose();
    }
    check();
    validateEmbedding(queryVector, provider.configuration.dimensions);
    const queryNorm = Math.hypot(...queryVector);
    // Read fresh after inference and disposal: no consent, eligibility or source
    // snapshot from before awaited work can authorize returned candidates.
    const candidates: SemanticCandidate[] = [];
    const qualifyingSessionIds: number[] = [];
    const truncation = store.scan(
        projectIds,
        (stored) => {
            const model = provider.configuration;
            if (stored.model !== model.model || stored.revision !== model.revision || stored.dimensions !== model.dimensions) {
                return;
            }
            const dot = stored.vector.reduce((total, value, index) => total + value * queryVector[index], 0);
            const similarity = Math.max(-1, Math.min(1, dot / (queryNorm * Math.hypot(...stored.vector))));
            if (options.minSimilarity !== undefined && similarity <= options.minSimilarity) {
                return;
            }
            qualifyingSessionIds.push(stored.sessionId);
            const candidate = { sessionId: stored.sessionId, similarity };
            const position = candidates.findIndex(
                (current) => current.similarity < similarity || (current.similarity === similarity && current.sessionId < stored.sessionId),
            );
            if (position === -1) {
                if (candidates.length < SEMANTIC_RECALL_MAX_HITS) {
                    candidates.push(candidate);
                }
            } else {
                if (candidates.length === SEMANTIC_RECALL_MAX_HITS) {
                    candidates.pop();
                }
                candidates.splice(position, 0, candidate);
            }
        },
        generation,
    );
    options.beforeUse?.();
    const selected = new Set(candidates.map((candidate) => candidate.sessionId));
    return { candidates, truncation, hitCapOmittedSessionIds: qualifyingSessionIds.filter((id) => !selected.has(id)) };
}

// Preserve both candidate sets. A lexical match also found semantically retains
// its semantic position; lexical-only matches keep their existing relative order.
export function unionRecallIds(lexicalIds: readonly number[], semantic: readonly SemanticCandidate[]): number[] {
    return [...new Set([...semantic.map((candidate) => candidate.sessionId), ...lexicalIds])];
}

function currentRecallProjectIds(db: Database, projects: ProjectSet[]): number[] {
    const allowed = new Set(new ProjectResolver(db).listConsentedStored(new ConsentStore(db)).flatMap((project) => project.projectIds));
    return projects.flatMap((project) => project.projectIds).filter((id) => allowed.has(id));
}

// Hydrate both candidate sets afresh after inference; the lexical reader's memo
// predates that await and cannot establish current eligibility or metadata.
export function currentRecallHits(db: Database, projects: ProjectSet[], sessionIds: readonly number[]) {
    return withMemoryReadGeneration(
        db,
        () => [],
        () => {
            const projectIds = currentRecallProjectIds(db, projects);
            return sessionIds.flatMap((id) => {
                const session = readEmbeddingSession(db, id, projectIds);
                const project =
                    session === undefined ? undefined : projects.find((project) => project.projectIds.includes(session.project_id));
                return session === undefined || project === undefined ? [] : [{ project, session }];
            });
        },
    );
}

export function renderSemanticUnion(
    db: Database,
    projects: ProjectSet[],
    query: RecallQuery,
    scope: RecallScope,
    lexical: LexicalRecallResult,
    semantic: SemanticRecallResult,
    now: number,
): LexicalRecallResult {
    if (lexical.state === 'locked') {
        return lexical;
    }
    return withMemoryReadGeneration(
        db,
        (): LexicalRecallResult => ({
            body: LOCKED_MEMORY_MESSAGE,
            sessionIds: [],
            state: 'locked',
            content_coverage: LOCKED_CONTENT_COVERAGE,
        }),
        () => {
            const scores = new Map(semantic.candidates.map((candidate) => [candidate.sessionId, candidate.similarity]));
            const selectedIds = new Set(unionRecallIds(lexical.sessionIds, semantic.candidates));
            // Retain the uncapped lexical identities for an exact, deduplicated total.
            // Revalidate omitted matches too: stale eligibility must not inflate that total.
            const current = currentRecallHits(db, projects, [...selectedIds]);
            const omittedIds = lexical.matchedSessionIds.filter((id) => !selectedIds.has(id));
            const eligibleIds = [
                ...current.map(({ session }) => session.id),
                ...readEligibleEmbeddingSessionIds(db, omittedIds, currentRecallProjectIds(db, projects)),
            ];
            const hits = current.map(({ project, session }) => {
                const similarity = scores.get(session.id);
                return {
                    ...hitIdentity({ project, session }),
                    discovery: similarity === undefined ? undefined : semanticDiscovery(similarity),
                };
            });
            const semanticNotice = semanticRecallNotices(semantic);
            if (
                semanticNotice === undefined &&
                semantic.candidates.length === 0 &&
                hits.length === lexical.sessionIds.length &&
                eligibleIds.length === lexical.matchedSessionIds.length
            ) {
                return lexical;
            }
            const render = (notice: string | undefined, maxHits: number) =>
                renderRecallBody(
                    query,
                    hits,
                    [lexical.coverage, notice].filter((value) => value !== undefined).join('\n') || undefined,
                    now,
                    scope,
                    projects[0],
                    lexical.usedLaxFallback,
                    maxHits,
                    eligibleIds,
                );
            // Reserve the full cap notice before applying the output budget. Reconcile
            // against the rendered identities without adding back budget-omitted hits.
            const rendered = render(semanticNotice, hits.length);
            const displayedNotice = semanticRecallNotices(semantic, rendered.sessionIds);
            return displayedNotice === semanticNotice ? rendered : render(displayedNotice, rendered.sessionIds.length);
        },
    );
}
