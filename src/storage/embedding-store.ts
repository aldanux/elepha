import type { Database } from 'better-sqlite3-multiple-ciphers';
import { SEMANTIC_SCAN_BUDGET_MS, SEMANTIC_SCAN_MAX_ROWS, SEMANTIC_SCAN_MAX_VECTOR_BYTES } from '../config/constants.js';
import { getSetting } from '../config/settings.js';
import { validateEmbedding } from '../embeddings/provider.js';
import type { EmbeddingModel } from '../embeddings/provider-config.js';
import { embeddingSourceHash, embeddingSourceText, MalformedEmbeddingSourceError } from '../embeddings/source.js';
import { escapeShellSyntax } from '../security/sanitize.js';
import { ConsentStore } from './consent-store.js';
import {
    type AuthenticatedReadGeneration,
    LOCKED_MEMORY_MESSAGE,
    memoryReadAuthorityMatchesGenerationInTransaction,
    withMemoryReadGeneration,
} from './paranoid-gate.js';
import { ProjectResolver } from './project-resolver.js';
import { readEmbeddingSession, type ServedSession } from './session-read-model.js';

export const MEMORY_PLUS_DISABLED = "elepha's Memory-Plus is off. Run `elepha enable memory-plus` first.";
export const EMBEDDING_SOURCE_CHANGED = 'Embedding source or authorization changed; vector was not stored. Re-run elepha embeddings.';

// Authorization projections exclude activity and presentation metadata. Schema
// coverage tests require every new column to be explicitly classified.
export const EMBEDDING_CONSENT_COLUMNS = ['id', 'ulid', 'path', 'state', 'decided_at', 'source'] as const;
export const EMBEDDING_PROJECT_AUTHORIZATION_COLUMNS = ['id', 'path', 'git_root', 'git_remote', 'git_root_commit'] as const;

export class EmbeddingSourceChangedError extends Error {
    constructor() {
        super(EMBEDDING_SOURCE_CHANGED);
    }
}

export interface EmbeddingSource {
    sessionId: number;
    projectId: number;
    rollupSessionId: number | null;
    identity: string;
    text: string;
    hash: string;
}

export type EmbeddingScanTruncation = 'rows' | 'time';

export interface StoredEmbedding extends EmbeddingModel {
    sessionId: number;
    vector: number[];
}

function sourceFor(session: ServedSession): EmbeddingSource | undefined {
    if (session.open_turn_staged_at != null && session.turn_count === 0 && session.rollup_state === null) {
        return undefined;
    }
    const text = embeddingSourceText(session);
    if (!text) {
        return undefined;
    }
    return {
        sessionId: session.id,
        projectId: session.project_id,
        rollupSessionId: session.rollup_state === null ? null : session.id,
        identity: JSON.stringify([
            session.tool,
            session.native_id,
            session.segment_index,
            session.project_id,
            session.source_path,
            session.started_at,
        ]),
        text,
        hash: embeddingSourceHash(text),
    };
}

export function lockedEmbedding(): never {
    throw new Error(LOCKED_MEMORY_MESSAGE);
}

export class EmbeddingStore {
    constructor(
        private readonly db: Database,
        private readonly configPath?: string,
    ) {}

    assertEnabled(): void {
        if (!getSetting('memory-plus', {}, this.configPath).value) {
            throw new Error(MEMORY_PLUS_DISABLED);
        }
    }

    // Snapshot only explicit consent decisions across a pass. Project activity
    // may change during ingestion; source reads still resolve eligibility live.
    generationConsent(generation: AuthenticatedReadGeneration): string {
        this.assertEnabled();
        return withMemoryReadGeneration(this.db, lockedEmbedding, () => JSON.stringify(this.consentRoots()), generation);
    }

    private projectIds(): number[] {
        return new ProjectResolver(this.db).listConsentedStored(new ConsentStore(this.db)).flatMap((project) => project.projectIds);
    }

    scan(
        projectIds: readonly number[],
        visit: (stored: StoredEmbedding) => void,
        generation?: AuthenticatedReadGeneration,
    ): EmbeddingScanTruncation | undefined {
        this.assertEnabled();
        return withMemoryReadGeneration(
            this.db,
            lockedEmbedding,
            () => {
                const authority = this.consentIdentity();
                const requested = new Set(projectIds);
                const allowed = this.projectIds().filter((id) => requested.has(id));
                const allowedSet = new Set(allowed);
                const started = performance.now();
                // Walk the integer primary key directly: no corpus-sized SQL sort
                // and no hidden scan of excluded projects between budget checks.
                // Recency is newest stored session, as in manual embedding jobs.
                const rows =
                    allowed.length === 0
                        ? []
                        : this.db
                              .prepare(`SELECT session_id, project_id
                    FROM session_embeddings NOT INDEXED ORDER BY session_id DESC`)
                              .iterate();
                const read = this.db.prepare(`SELECT rollup_session_id, source_hash,
                    model, model_revision, dimensions, length(vector) AS vector_bytes,
                    CASE WHEN length(vector) <= ? THEN vector ELSE NULL END AS vector
                    FROM session_embeddings WHERE session_id = ?`);
                let scanned = 0;
                let truncation: EmbeddingScanTruncation | undefined;
                for (const identity of rows as Iterable<{ session_id: number; project_id: number }>) {
                    if (performance.now() - started >= SEMANTIC_SCAN_BUDGET_MS) {
                        truncation = 'time';
                        break;
                    }
                    if (!allowedSet.has(identity.project_id)) {
                        continue;
                    }
                    // One in-scope identity of lookahead distinguishes exhaustion
                    // from loss without hydrating a row beyond the budget.
                    if (scanned >= SEMANTIC_SCAN_MAX_ROWS) {
                        truncation = 'rows';
                        break;
                    }
                    scanned++;
                    const row = {
                        ...identity,
                        ...(read.get(SEMANTIC_SCAN_MAX_VECTOR_BYTES, identity.session_id) as {
                            rollup_session_id: number | null;
                            source_hash: string;
                            model: string;
                            model_revision: string;
                            dimensions: number;
                            vector_bytes: number;
                            vector: Buffer | null;
                        }),
                    };
                    if (row.vector === null || row.vector_bytes > SEMANTIC_SCAN_MAX_VECTOR_BYTES) {
                        throw new Error(`Session ${row.session_id}: stored embedding exceeds the vector byte limit.`);
                    }
                    const session = readEmbeddingSession(this.db, row.session_id, allowed);
                    const source = session === undefined ? undefined : sourceFor(session);
                    if (
                        source === undefined ||
                        source.projectId !== row.project_id ||
                        source.hash !== row.source_hash ||
                        source.rollupSessionId !== row.rollup_session_id
                    ) {
                        continue;
                    }
                    if (row.vector.length !== row.dimensions * 4) {
                        throw new Error(`Session ${row.session_id}: invalid stored embedding dimensions.`);
                    }
                    const bytes = row.vector;
                    const vector = Array.from({ length: row.dimensions }, (_, index) => bytes.readFloatLE(index * 4));
                    validateEmbedding(vector, row.dimensions);
                    visit({
                        sessionId: row.session_id,
                        model: row.model,
                        revision: row.model_revision,
                        dimensions: row.dimensions,
                        vector,
                    });
                }
                this.assertEnabled();
                if (authority !== this.consentIdentity()) {
                    throw new Error(EMBEDDING_SOURCE_CHANGED);
                }
                return truncation;
            },
            generation,
        );
    }

    source(sessionId: number, generation?: AuthenticatedReadGeneration): EmbeddingSource | undefined {
        this.assertEnabled();
        return withMemoryReadGeneration(
            this.db,
            lockedEmbedding,
            (token) => {
                const authority = this.consentIdentity();
                const session = readEmbeddingSession(this.db, sessionId, this.projectIds());
                const source = session === undefined ? undefined : this.readSource(session, token, authority);
                if (authority !== this.consentIdentity()) {
                    throw new Error(EMBEDDING_SOURCE_CHANGED);
                }
                return source;
            },
            generation,
        );
    }

    assertCurrent(source: EmbeddingSource, generation: AuthenticatedReadGeneration): void {
        const current = this.source(source.sessionId, generation);
        if (current === undefined || current.identity !== source.identity) {
            throw new Error(EMBEDDING_SOURCE_CHANGED);
        }
        if (JSON.stringify(current) !== JSON.stringify(source)) {
            this.rejectSource(source.sessionId, new EmbeddingSourceChangedError(), generation);
        }
    }

    current(source: EmbeddingSource, model: EmbeddingModel, generation: AuthenticatedReadGeneration): boolean {
        this.assertCurrent(source, generation);
        return (
            this.db
                .prepare(`SELECT 1 FROM session_embeddings
            WHERE session_id = ? AND source_hash = ? AND model = ? AND model_revision = ? AND dimensions = ?
              AND rollup_session_id IS ? AND project_id = ?`)
                .get(
                    source.sessionId,
                    source.hash,
                    model.model,
                    model.revision,
                    model.dimensions,
                    source.rollupSessionId,
                    source.projectId,
                ) !== undefined
        );
    }

    // A source snapshot survives awaited model work only as a comparison value.
    // Re-authenticate outside the writer, then repeat the DB-only checks inside.
    write(source: EmbeddingSource, model: EmbeddingModel, vector: number[], generation: AuthenticatedReadGeneration): void {
        this.assertCurrent(source, generation);
        validateEmbedding(vector, model.dimensions);
        const authority = this.consentIdentity();
        const projectIds = this.projectIds();
        const bytes = Buffer.alloc(vector.length * 4);
        vector.forEach((value, index) => {
            bytes.writeFloatLE(value, index * 4);
        });
        this.assertEnabled();
        withMemoryReadGeneration(
            this.db,
            lockedEmbedding,
            () => {
                const write = this.db.transaction(() => {
                    if (!memoryReadAuthorityMatchesGenerationInTransaction(this.db, generation)) {
                        lockedEmbedding();
                    }
                    if (authority !== this.consentIdentity()) {
                        throw new Error(EMBEDDING_SOURCE_CHANGED);
                    }
                    const row = readEmbeddingSession(this.db, source.sessionId, projectIds);
                    const current = row === undefined ? undefined : sourceFor(row);
                    if (current === undefined || current.identity !== source.identity) {
                        throw new Error(EMBEDDING_SOURCE_CHANGED);
                    }
                    if (JSON.stringify(current) !== JSON.stringify(source)) {
                        throw new EmbeddingSourceChangedError();
                    }
                    this.db
                        .prepare(`INSERT INTO session_embeddings
                    (session_id, rollup_session_id, project_id, source_hash, model, model_revision, dimensions, vector, computed_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(session_id) DO UPDATE SET
                        rollup_session_id = excluded.rollup_session_id, project_id = excluded.project_id,
                        source_hash = excluded.source_hash, model = excluded.model, model_revision = excluded.model_revision,
                        dimensions = excluded.dimensions, vector = excluded.vector, computed_at = excluded.computed_at`)
                        .run(
                            source.sessionId,
                            source.rollupSessionId,
                            source.projectId,
                            source.hash,
                            escapeShellSyntax(model.model),
                            escapeShellSyntax(model.revision),
                            model.dimensions,
                            bytes,
                            new Date().toISOString(),
                        );
                });
                try {
                    write.immediate();
                } catch (error) {
                    // Re-authenticate only after rollback releases the writer.
                    this.rejectSource(source.sessionId, error, generation, authority);
                }
            },
            generation,
        );
    }

    private readSource(session: ServedSession, generation?: AuthenticatedReadGeneration, authority?: string): EmbeddingSource | undefined {
        try {
            return sourceFor(session);
        } catch (error) {
            return this.rejectSource(session.id, error, generation, authority);
        }
    }

    // Only the store may classify a source error as skippable. Parsing failures
    // must not hide a concurrent project regrouping or session eligibility loss.
    private rejectSource(sessionId: number, error: unknown, generation?: AuthenticatedReadGeneration, authority?: string): never {
        if (error instanceof MalformedEmbeddingSourceError || error instanceof EmbeddingSourceChangedError) {
            this.assertEnabled();
            withMemoryReadGeneration(
                this.db,
                lockedEmbedding,
                () => {
                    if (
                        readEmbeddingSession(this.db, sessionId, this.projectIds()) === undefined ||
                        (authority !== undefined && authority !== this.consentIdentity())
                    ) {
                        throw new Error(EMBEDDING_SOURCE_CHANGED);
                    }
                },
                generation,
            );
        }
        throw error;
    }

    private consentRoots(): unknown[] {
        return this.db.prepare(`SELECT ${EMBEDDING_CONSENT_COLUMNS.join(', ')} FROM consent_roots ORDER BY id`).all();
    }

    private consentIdentity(): string {
        return JSON.stringify([
            this.consentRoots(),
            this.db.prepare(`SELECT ${EMBEDDING_PROJECT_AUTHORIZATION_COLUMNS.join(', ')} FROM projects ORDER BY id`).all(),
        ]);
    }
}
