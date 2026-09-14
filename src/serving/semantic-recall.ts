import type { Database } from 'better-sqlite3-multiple-ciphers';
import { SEMANTIC_RECALL_MAX_HITS } from '../config/constants.js';
import { getSetting } from '../config/settings.js';
import type { createEmbeddingProvider } from '../embeddings/provider-config.js';
import { escapeShellSyntax } from '../security/sanitize.js';
import { ConsentStore } from '../storage/consent-store.js';
import { withMemoryReadGeneration } from '../storage/paranoid-gate.js';
import { ProjectResolver, type ProjectSet } from '../storage/project-resolver.js';
import { readEmbeddingSession } from '../storage/session-read-model.js';
import { hitIdentity, type LexicalRecallResult, type RecallQuery, type RecallScope, renderRecallBody } from './lexical-recall.js';

export interface SemanticCandidate {
    sessionId: number;
    similarity: number;
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
        environment?: NodeJS.ProcessEnv;
        createProvider?: typeof createEmbeddingProvider;
        beforeUse?: () => void;
    } = {},
): Promise<SemanticCandidate[]> {
    // Keep all embedding imports, provider configuration and vector reads behind
    // the opt-in. Checking the setting itself never loads the optional runtime.
    if (!getSetting('memory-plus', {}, options.configPath).value || projectIds.length === 0 || !query.trim()) {
        return [];
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
    const provider = await (options.createProvider ?? createEmbeddingProvider)(true, options.environment);
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
    const candidates = store.scan(projectIds, generation).flatMap((stored) => {
        const model = provider.configuration;
        if (stored.model !== model.model || stored.revision !== model.revision || stored.dimensions !== model.dimensions) {
            return [];
        }
        const dot = stored.vector.reduce((total, value, index) => total + value * queryVector[index], 0);
        const similarity = Math.max(-1, Math.min(1, dot / (queryNorm * Math.hypot(...stored.vector))));
        return [{ sessionId: stored.sessionId, similarity }];
    });
    candidates.sort((a, b) => b.similarity - a.similarity || a.sessionId - b.sessionId);
    options.beforeUse?.();
    return candidates.slice(0, SEMANTIC_RECALL_MAX_HITS);
}

// Preserve both candidate sets. A lexical match also found semantically retains
// its semantic position; lexical-only matches keep their existing relative order.
export function unionRecallIds(lexicalIds: readonly number[], semantic: readonly SemanticCandidate[]): number[] {
    return [...new Set([...semantic.map((candidate) => candidate.sessionId), ...lexicalIds])];
}

// Hydrate both candidate sets afresh after inference; the lexical reader's memo
// predates that await and cannot establish current eligibility or metadata.
export function currentRecallHits(db: Database, projects: ProjectSet[], sessionIds: readonly number[]) {
    return withMemoryReadGeneration(
        db,
        () => [],
        () => {
            const allowed = new Set(
                new ProjectResolver(db).listConsentedStored(new ConsentStore(db)).flatMap((project) => project.projectIds),
            );
            const projectIds = projects.flatMap((project) => project.projectIds).filter((id) => allowed.has(id));
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
    semantic: readonly SemanticCandidate[],
    now: number,
): LexicalRecallResult {
    if (lexical.state === 'locked') {
        return lexical;
    }
    const scores = new Map(semantic.map((candidate) => [candidate.sessionId, candidate.similarity]));
    const hits = currentRecallHits(db, projects, unionRecallIds(lexical.sessionIds, semantic)).map(({ project, session }) => {
        const similarity = scores.get(session.id);
        return { ...hitIdentity({ project, session }), discovery: similarity === undefined ? undefined : semanticDiscovery(similarity) };
    });
    if (semantic.length === 0 && hits.length === lexical.sessionIds.length) {
        return lexical;
    }
    return renderRecallBody(query, hits, lexical.coverage, now, scope, projects[0], false, hits.length);
}
