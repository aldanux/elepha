import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import type { Database } from 'better-sqlite3-multiple-ciphers';
import {
    CURRENT_CHAT_EVIDENCE_MAX_ID_BYTES,
    CURRENT_CHAT_EVIDENCE_MAX_PATH_BYTES,
    DURABLE_CAPTURE_FILTER_VERSION,
} from '../config/constants.js';
import { canonicalizeExisting } from '../config/paths.js';
import { getSetting } from '../config/settings.js';
import { validateEmbedding } from '../embeddings/provider.js';
import type { EmbeddingModel } from '../embeddings/provider-config.js';
import { escapeShellSyntax } from '../security/sanitize.js';
import type { ToolName } from '../types/index.js';
import { ConsentStore } from './consent-store.js';
import { runSessionLiveMemoryWrite } from './live-memory-retention.js';
import { retentionRemovedSql } from './live-memory-retention-schema.js';
import {
    type AuthenticatedReadGeneration,
    memoryReadAuthorityMatchesGenerationInTransaction,
    withMemoryReadGeneration,
} from './paranoid-gate.js';

import { ProjectResolver } from './project-resolver.js';
import { SERVED_SESSION_KIND_ELIGIBILITY } from './session-read-model.js';
import { TURN_EMBEDDING_REFRESH_STATE_TABLE, TURN_EMBEDDINGS_TABLE } from './turn-embeddings.js';
import { TURN_SEARCH_INDEX_TABLE } from './turn-search-index.js';

export class TurnEmbeddingSourceChangedError extends Error {
    constructor() {
        super('Turn source or authorization changed; vector was not stored.');
    }
}

export interface TurnEmbeddingCandidate {
    memoryId: number;
    sessionId: number;
    projectId: number;
    turnIndex: number;
    tool: ToolName;
    native_id: string | null;
    source_path: string | null;
    projectPath: string | null;
    sourceDigest: string | null;
    filterVersion: number;
    sourceGeneration: number;
    reingested: number;
}

interface RefreshStateRow {
    before_memory_id: number | null;
    model: string;
    model_revision: string;
    dimensions: number;
    authority_hash: string;
    authority_epoch: number;
    sweep_issue_hash: string;
    sweep_unavailable: number;
    sweep_changed: number;
    sweep_failed: number;
    last_reported_issue_hash: string;
}

export interface TurnEmbeddingRefreshState {
    beforeMemoryId?: number;
    authorityHash: string;
    authorityEpoch: number;
}

export interface TurnEmbeddingRefreshIssues {
    unavailable: number;
    sourceChanged: number;
    failed: number;
    keys: readonly string[];
}

export interface TurnEmbeddingRefreshDiagnostic {
    unavailable: number;
    changed: number;
    failed: number;
}

const CANDIDATE_SELECT = `SELECT m.id AS memoryId, s.id AS sessionId, m.project_id AS projectId,
    m.turn_index AS turnIndex, s.tool,
    CASE WHEN length(CAST(s.native_id AS BLOB)) <= ${CURRENT_CHAT_EVIDENCE_MAX_ID_BYTES} THEN s.native_id END AS native_id,
    CASE WHEN length(CAST(s.source_path AS BLOB)) <= ${CURRENT_CHAT_EVIDENCE_MAX_PATH_BYTES} THEN s.source_path END AS source_path,
    CASE WHEN length(CAST(p.path AS BLOB)) <= ${CURRENT_CHAT_EVIDENCE_MAX_PATH_BYTES} THEN p.path END AS projectPath,
    CASE WHEN length(CAST(tsi.source_digest AS BLOB)) = 64 THEN tsi.source_digest END AS sourceDigest,
    tsi.filter_version AS filterVersion, (m.reingested_at IS NOT NULL) AS reingested,
    COALESCE(g.generation, 0) AS sourceGeneration
    FROM ${TURN_SEARCH_INDEX_TABLE} tsi
    JOIN memories m ON m.id = tsi.memory_id
    JOIN sessions s ON s.id = m.session_id AND s.project_id = m.project_id
    JOIN projects p ON p.id = m.project_id
    LEFT JOIN source_generations g ON g.tool = s.tool AND g.native_id = s.native_id
    WHERE tsi.coverage IN ('included', 'truncated') AND ${SERVED_SESSION_KIND_ELIGIBILITY}
      AND NOT EXISTS (SELECT 1 FROM purged_transcripts x WHERE x.tool = s.tool AND x.native_id = s.native_id) AND NOT ${retentionRemovedSql('s.tool', 's.native_id')}
      AND NOT EXISTS (SELECT 1 FROM incognito_transcripts x WHERE x.tool = s.tool AND x.native_id = s.native_id)`;

export class TurnEmbeddingStore {
    constructor(
        private readonly db: Database,
        private readonly configPath?: string,
    ) {}

    enabled(): boolean {
        return getSetting('memory-plus', {}, this.configPath).value;
    }

    // The worker carries its sweep cursor only across an unchanged consent and
    // project-authorization view. Physical paths are rechecked per candidate.
    private authorityHash(): string {
        const hash = createHash('sha256');
        for (const row of this.db.prepare('SELECT id, ulid, path, state, decided_at, source FROM consent_roots ORDER BY id').iterate()) {
            hash.update(JSON.stringify(row));
            hash.update('\n');
        }
        hash.update('--projects--\n');
        for (const row of this.db.prepare('SELECT id, path, git_root, git_remote, git_root_commit FROM projects ORDER BY id').iterate()) {
            hash.update(JSON.stringify(row));
            hash.update('\n');
        }
        return hash.digest('hex');
    }

    refreshState(model: EmbeddingModel): TurnEmbeddingRefreshState {
        if (!this.enabled()) {
            throw new TurnEmbeddingSourceChangedError();
        }
        const authorityHash = this.authorityHash();
        const current = this.db.prepare(`SELECT * FROM ${TURN_EMBEDDING_REFRESH_STATE_TABLE} WHERE id = 1`).get() as
            | RefreshStateRow
            | undefined;
        if (
            current?.model === model.model &&
            current.model_revision === model.revision &&
            current.dimensions === model.dimensions &&
            current.authority_hash === authorityHash
        ) {
            return {
                beforeMemoryId: current.before_memory_id ?? undefined,
                authorityHash,
                authorityEpoch: current.authority_epoch,
            };
        }
        return this.db
            .transaction(() => {
                if (this.authorityHash() !== authorityHash) {
                    throw new TurnEmbeddingSourceChangedError();
                }
                let row = this.db.prepare(`SELECT * FROM ${TURN_EMBEDDING_REFRESH_STATE_TABLE} WHERE id = 1`).get() as
                    | RefreshStateRow
                    | undefined;
                if (
                    row === undefined ||
                    row.model !== model.model ||
                    row.model_revision !== model.revision ||
                    row.dimensions !== model.dimensions ||
                    row.authority_hash !== authorityHash
                ) {
                    this.db
                        .prepare(`INSERT INTO ${TURN_EMBEDDING_REFRESH_STATE_TABLE}
                        (id, before_memory_id, model, model_revision, dimensions, authority_hash)
                        VALUES (1, NULL, ?, ?, ?, ?)
                        ON CONFLICT(id) DO UPDATE SET
                            before_memory_id = NULL, model = excluded.model,
                            model_revision = excluded.model_revision, dimensions = excluded.dimensions,
                            authority_hash = excluded.authority_hash, sweep_issue_hash = '',
                            sweep_unavailable = 0, sweep_changed = 0, sweep_failed = 0,
                            last_reported_issue_hash = ''`)
                        .run(model.model, model.revision, model.dimensions, authorityHash);
                    row = this.db.prepare(`SELECT * FROM ${TURN_EMBEDDING_REFRESH_STATE_TABLE} WHERE id = 1`).get() as RefreshStateRow;
                }
                return {
                    beforeMemoryId: row.before_memory_id ?? undefined,
                    authorityHash,
                    authorityEpoch: row.authority_epoch,
                };
            })
            .immediate();
    }

    saveRefreshState(
        model: EmbeddingModel,
        expectedAuthorityHash: string,
        expectedAuthorityEpoch: number,
        beforeMemoryId: number | undefined,
        issues: TurnEmbeddingRefreshIssues,
    ): TurnEmbeddingRefreshDiagnostic | undefined {
        if (beforeMemoryId !== undefined && (!Number.isSafeInteger(beforeMemoryId) || beforeMemoryId <= 0)) {
            throw new Error('Invalid turn embedding refresh cursor.');
        }
        if (!this.enabled()) {
            throw new TurnEmbeddingSourceChangedError();
        }
        return this.db
            .transaction(() => {
                const row = this.db.prepare(`SELECT * FROM ${TURN_EMBEDDING_REFRESH_STATE_TABLE} WHERE id = 1`).get() as
                    | RefreshStateRow
                    | undefined;
                // Consent/project triggers advance the epoch in the same write
                // transaction, so this check catches changes across awaits.
                if (
                    row === undefined ||
                    row.authority_epoch !== expectedAuthorityEpoch ||
                    row.model !== model.model ||
                    row.model_revision !== model.revision ||
                    row.dimensions !== model.dimensions ||
                    row.authority_hash !== expectedAuthorityHash
                ) {
                    throw new TurnEmbeddingSourceChangedError();
                }
                const issueHash = createHash('sha256').update(row.sweep_issue_hash).update(JSON.stringify(issues.keys)).digest('hex');
                const unavailable = row.sweep_unavailable + issues.unavailable;
                const changed = row.sweep_changed + issues.sourceChanged;
                const failed = row.sweep_failed + issues.failed;
                const complete = beforeMemoryId === undefined;
                const report = complete && unavailable + changed + failed > 0 && issueHash !== row.last_reported_issue_hash;
                this.db
                    .prepare(`UPDATE ${TURN_EMBEDDING_REFRESH_STATE_TABLE} SET
                        before_memory_id = ?, sweep_issue_hash = ?, sweep_unavailable = ?,
                        sweep_changed = ?, sweep_failed = ?, last_reported_issue_hash = ? WHERE id = 1`)
                    .run(
                        beforeMemoryId ?? null,
                        complete ? '' : issueHash,
                        complete ? 0 : unavailable,
                        complete ? 0 : changed,
                        complete ? 0 : failed,
                        complete ? (unavailable + changed + failed === 0 ? '' : issueHash) : row.last_reported_issue_hash,
                    );
                return report ? { unavailable, changed, failed } : undefined;
            })
            .immediate();
    }

    page(before: number, limit: number, generation: AuthenticatedReadGeneration): TurnEmbeddingCandidate[] {
        return withMemoryReadGeneration(
            this.db,
            () => {
                throw new TurnEmbeddingSourceChangedError();
            },
            () => {
                const allowed = new ProjectResolver(this.db)
                    .listConsentedStored(new ConsentStore(this.db))
                    .flatMap((project) => project.projectIds);
                if (allowed.length === 0) {
                    return [];
                }
                return this.db
                    .prepare(`${CANDIDATE_SELECT} AND m.project_id IN (SELECT value FROM json_each(?))
                        AND m.id < ? ORDER BY m.id DESC LIMIT ?`)
                    .all(JSON.stringify(allowed), before, limit) as TurnEmbeddingCandidate[];
            },
            generation,
        );
    }

    assertCurrent(candidate: TurnEmbeddingCandidate, generation: AuthenticatedReadGeneration): ReadonlyMap<string, string> {
        if (!this.enabled()) {
            throw new TurnEmbeddingSourceChangedError();
        }
        return withMemoryReadGeneration(
            this.db,
            () => {
                throw new TurnEmbeddingSourceChangedError();
            },
            () => {
                const current = this.db.prepare(`${CANDIDATE_SELECT} AND m.id = ?`).get(candidate.memoryId) as
                    | TurnEmbeddingCandidate
                    | undefined;
                if (
                    current === undefined ||
                    JSON.stringify(current) !== JSON.stringify(candidate) ||
                    current.filterVersion !== DURABLE_CAPTURE_FILTER_VERSION ||
                    current.sourceDigest === null ||
                    current.projectPath === null
                ) {
                    throw new TurnEmbeddingSourceChangedError();
                }
                const consent = new ConsentStore(this.db);
                const group = new ProjectResolver(this.db).storedProjectForAuthorization(candidate.projectId);
                if (group === undefined) {
                    throw new TurnEmbeddingSourceChangedError();
                }
                const canonicalPaths = new Map<string, string>();
                for (const projectPath of group.paths) {
                    let canonical: string | undefined;
                    try {
                        if (statSync(projectPath).isDirectory()) {
                            canonical = canonicalizeExisting(projectPath);
                        }
                    } catch {
                        // A missing or substituted checkout fails closed below.
                    }
                    if (canonical === undefined) {
                        throw new TurnEmbeddingSourceChangedError();
                    }
                    canonicalPaths.set(projectPath, canonical);
                }
                if (!new ProjectResolver(this.db).isStoredProjectConsented(candidate.projectId, consent, canonicalPaths)) {
                    throw new TurnEmbeddingSourceChangedError();
                }
                return canonicalPaths;
            },
            generation,
        );
    }

    current(candidate: TurnEmbeddingCandidate, hash: string, model: EmbeddingModel, generation: AuthenticatedReadGeneration): boolean {
        this.assertCurrent(candidate, generation);
        return (
            this.db
                .prepare(`SELECT 1 FROM ${TURN_EMBEDDINGS_TABLE}
                    WHERE memory_id = ? AND project_id = ? AND source_digest = ? AND text_hash = ?
                      AND model = ? AND model_revision = ? AND dimensions = ?`)
                .get(
                    candidate.memoryId,
                    candidate.projectId,
                    candidate.sourceDigest,
                    hash,
                    model.model,
                    model.revision,
                    model.dimensions,
                ) !== undefined
        );
    }

    write(
        candidate: TurnEmbeddingCandidate,
        hash: string,
        model: EmbeddingModel,
        vector: number[],
        generation: AuthenticatedReadGeneration,
    ): void {
        validateEmbedding(vector, model.dimensions);
        const canonicalPaths = this.assertCurrent(candidate, generation);
        const bytes = Buffer.alloc(vector.length * 4);
        vector.forEach((value, index) => {
            bytes.writeFloatLE(value, index * 4);
        });
        withMemoryReadGeneration(
            this.db,
            () => {
                throw new TurnEmbeddingSourceChangedError();
            },
            () => {
                const write = this.db.transaction(() => {
                    if (!memoryReadAuthorityMatchesGenerationInTransaction(this.db, generation)) {
                        throw new TurnEmbeddingSourceChangedError();
                    }
                    const current = this.db.prepare(`${CANDIDATE_SELECT} AND m.id = ?`).get(candidate.memoryId) as
                        | TurnEmbeddingCandidate
                        | undefined;
                    if (
                        current === undefined ||
                        JSON.stringify(current) !== JSON.stringify(candidate) ||
                        current.filterVersion !== DURABLE_CAPTURE_FILTER_VERSION ||
                        current.sourceDigest === null ||
                        !new ProjectResolver(this.db).isStoredProjectConsented(
                            candidate.projectId,
                            new ConsentStore(this.db),
                            canonicalPaths,
                        )
                    ) {
                        throw new TurnEmbeddingSourceChangedError();
                    }

                    this.db
                        .prepare(`INSERT INTO ${TURN_EMBEDDINGS_TABLE}
                          (memory_id, project_id, source_digest, text_hash, model, model_revision, dimensions, vector, computed_at)
                          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                          ON CONFLICT(memory_id) DO UPDATE SET
                            project_id = excluded.project_id, source_digest = excluded.source_digest,
                            text_hash = excluded.text_hash, model = excluded.model,
                            model_revision = excluded.model_revision, dimensions = excluded.dimensions,
                            vector = excluded.vector, computed_at = excluded.computed_at`)
                        .run(
                            candidate.memoryId,
                            candidate.projectId,
                            candidate.sourceDigest,
                            hash,
                            escapeShellSyntax(model.model),
                            escapeShellSyntax(model.revision),
                            model.dimensions,
                            bytes,
                            new Date().toISOString(),
                        );
                });
                runSessionLiveMemoryWrite(this.db, candidate.sessionId, () => write.immediate());
            },
            generation,
        );
    }
}
