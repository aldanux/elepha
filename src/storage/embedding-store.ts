import type { Database } from 'better-sqlite3-multiple-ciphers';
import { getSetting } from '../config/settings.js';
import { validateEmbedding } from '../embeddings/provider.js';
import type { EmbeddingModel } from '../embeddings/provider-config.js';
import { embeddingSourceHash, embeddingSourceText } from '../embeddings/source.js';
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

export const MEMORY_PLUS_DISABLED = 'elepha\'s "Memory-Plus" is off. Run `elepha enable memory-plus` first.';
export const EMBEDDING_SOURCE_CHANGED = 'Embedding source or authorization changed; vector was not stored. Re-run elepha embeddings.';

export interface EmbeddingSource {
    sessionId: number;
    projectId: number;
    rollupSessionId: number | null;
    identity: string;
    text: string;
    hash: string;
}

export interface StoredEmbedding extends EmbeddingModel {
    sessionId: number;
    vector: number[];
}

function sourceFor(session: ServedSession): EmbeddingSource | undefined {
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

    private projectIds(): number[] {
        return new ProjectResolver(this.db).listConsentedStored(new ConsentStore(this.db)).flatMap((project) => project.projectIds);
    }

    scan(projectIds: readonly number[], generation?: AuthenticatedReadGeneration): StoredEmbedding[] {
        this.assertEnabled();
        return withMemoryReadGeneration(
            this.db,
            lockedEmbedding,
            () => {
                const authority = this.consentIdentity();
                const requested = new Set(projectIds);
                const allowed = this.projectIds().filter((id) => requested.has(id));
                const rows = this.db
                    .prepare(`SELECT session_id, project_id, rollup_session_id, source_hash,
                model, model_revision, dimensions, vector FROM session_embeddings
                WHERE project_id IN (SELECT value FROM json_each(?)) ORDER BY session_id`)
                    .iterate(JSON.stringify(allowed));
                const vectors: StoredEmbedding[] = [];
                for (const row of rows as Iterable<{
                    session_id: number;
                    project_id: number;
                    rollup_session_id: number | null;
                    source_hash: string;
                    model: string;
                    model_revision: string;
                    dimensions: number;
                    vector: Buffer;
                }>) {
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
                    const vector = Array.from({ length: row.dimensions }, (_, index) => row.vector.readFloatLE(index * 4));
                    validateEmbedding(vector, row.dimensions);
                    vectors.push({
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
                return vectors;
            },
            generation,
        );
    }

    source(sessionId: number, generation?: AuthenticatedReadGeneration): EmbeddingSource | undefined {
        this.assertEnabled();
        return withMemoryReadGeneration(
            this.db,
            lockedEmbedding,
            () => {
                const authority = this.consentIdentity();
                const session = readEmbeddingSession(this.db, sessionId, this.projectIds());
                const source = session === undefined ? undefined : sourceFor(session);
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
        if (current === undefined || JSON.stringify(current) !== JSON.stringify(source)) {
            throw new Error(EMBEDDING_SOURCE_CHANGED);
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
                this.db
                    .transaction(() => {
                        if (!memoryReadAuthorityMatchesGenerationInTransaction(this.db, generation)) {
                            lockedEmbedding();
                        }
                        if (authority !== this.consentIdentity()) {
                            throw new Error(EMBEDDING_SOURCE_CHANGED);
                        }
                        const row = readEmbeddingSession(this.db, source.sessionId, projectIds);
                        if (row === undefined || JSON.stringify(sourceFor(row)) !== JSON.stringify(source)) {
                            throw new Error(EMBEDDING_SOURCE_CHANGED);
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
                    })
                    .immediate();
            },
            generation,
        );
    }

    private consentIdentity(): string {
        return JSON.stringify([
            this.db.prepare('SELECT * FROM consent_roots ORDER BY id').all(),
            this.db.prepare('SELECT * FROM projects ORDER BY id').all(),
        ]);
    }
}
