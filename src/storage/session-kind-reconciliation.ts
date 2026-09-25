import { setImmediate as yieldImmediate } from 'node:timers/promises';
import type { Database } from 'better-sqlite3-multiple-ciphers';
import { readCodexKindPreamble } from '../adapters/codex.js';
import {
    SESSION_KIND_RECONCILIATION_BATCH_SIZE,
    SESSION_KIND_RECONCILIATION_BUDGET_MS,
    SESSION_KIND_REVISION,
} from '../config/constants.js';
import { openProviderTranscript, type ProviderTranscriptOpener } from '../security/provider-transcript.js';
import { stripShellSyntax } from '../security/sanitize.js';
import { errorMessage } from '../util/error.js';
import type { MemoryStore } from './memory-store.js';
import { isMemoryLocked } from './paranoid-gate.js';
import { sourceGeneration, sourceSnapshotValidator } from './source-reconciliation.js';

const SUMMARY_KEY = 'session_kind_reconciliation';
export const SESSION_KIND_RECONCILIATION_LOG_PREFIX = '[elepha] session classification:';

export interface SessionKindStatus {
    pending: number;
    incidents: number;
    updating?: boolean;
}

export interface KindReconciliationContinuation {
    afterId: number;
    incidents: number;
    hasMore: boolean;
}

interface Candidate extends Record<string, unknown> {
    id: number;
    native_id: string;
    source_path: string;
    kind: string | null;
    kind_revision: number;
    project_path: string;
}

export function sessionKindStatus(db: Database): SessionKindStatus {
    const pending = (
        db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE tool = ? AND kind_revision < ?').get('codex', SESSION_KIND_REVISION) as {
            n: number;
        }
    ).n;
    const saved = db.prepare('SELECT value FROM meta WHERE key = ?').get(SUMMARY_KEY) as { value: string } | undefined;
    let incidents = 0;
    let updating = false;
    if (saved) {
        try {
            const value: unknown = JSON.parse(saved.value);
            if (
                value &&
                typeof value === 'object' &&
                'revision' in value &&
                value.revision === SESSION_KIND_REVISION &&
                'state' in value &&
                (value.state === 'running' || value.state === 'scheduled')
            ) {
                updating = true;
            }
            if (
                value &&
                typeof value === 'object' &&
                'revision' in value &&
                value.revision === SESSION_KIND_REVISION &&
                'incidents' in value &&
                typeof value.incidents === 'number' &&
                Number.isSafeInteger(value.incidents) &&
                value.incidents > 0
            ) {
                incidents = value.incidents;
            }
        } catch {
            incidents = pending > 0 ? 1 : 0;
        }
    }
    return { pending, incidents: pending > 0 ? incidents : 0, updating: pending > 0 && updating };
}

// A cancelled scheduled pass must not look active after graceful shutdown.
export function settleSessionKindReconciliation(db: Database): void {
    const status = sessionKindStatus(db);
    db.prepare("UPDATE meta SET value = json_set(value, '$.state', ?) WHERE key = ?").run(
        status.pending > 0 ? 'waiting' : 'complete',
        SUMMARY_KEY,
    );
}

export interface KindReconciliationOptions {
    openTranscript?: ProviderTranscriptOpener;
    stopped?: () => boolean;
    log?: (message: string) => void;
    warn?: (message: string) => void;
    // Deterministic cancellation/budget checkpoints for fixture tests.
    yieldBatch?: () => Promise<void>;
    now?: () => number;
    // Process-local traversal survives bounded passes, never daemon restarts.
    continuation?: KindReconciliationContinuation;
}

// A revision is a per-row acknowledgement, never a global cursor. Failed
// sources remain eligible after restoration, reapproval, or daemon restart.
export async function reconcileSessionKinds(
    store: MemoryStore,
    options: KindReconciliationOptions = {},
): Promise<{
    checked: number;
    reclassified: number;
    pending: number;
    incidents: number;
    malformed: number;
}> {
    const db = store.database;
    const openTranscript = options.openTranscript ?? openProviderTranscript;
    const stopped = options.stopped ?? (() => false);
    const now = options.now ?? Date.now;
    const deadline = now() + SESSION_KIND_RECONCILIATION_BUDGET_MS;
    const yieldBatch = options.yieldBatch ?? (() => yieldImmediate());
    const summary = { checked: 0, reclassified: 0, pending: sessionKindStatus(db).pending, incidents: 0, malformed: 0 };
    const save = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    save.run(
        SUMMARY_KEY,
        JSON.stringify({ revision: SESSION_KIND_REVISION, state: 'running', incidents: options.continuation?.incidents ?? 0 }),
    );
    const readRows = db.prepare(`SELECT s.*, p.path AS project_path FROM sessions s JOIN projects p ON p.id = s.project_id
        WHERE s.tool = 'codex' AND s.source_path = ? AND s.kind_revision < ? ORDER BY s.id`);
    let afterId = options.continuation?.afterId ?? 0;
    while (!stopped() && now() < deadline) {
        // Include completed segments in the source key so a partial repair
        // cannot move its remaining revoked segment past this startup cursor.
        const sources = db
            .prepare(`SELECT source_path, MIN(id) AS first_id FROM sessions
            WHERE tool = 'codex' GROUP BY source_path
            HAVING MIN(id) > ? AND MIN(kind_revision) < ? ORDER BY first_id LIMIT ?`)
            .all(afterId, SESSION_KIND_REVISION, SESSION_KIND_RECONCILIATION_BATCH_SIZE) as Array<{
            source_path: string;
            first_id: number;
        }>;
        if (sources.length === 0) {
            break;
        }
        for (const source of sources) {
            if (stopped() || now() >= deadline) {
                break;
            }
            afterId = source.first_id;
            // Capture row identity and source generation before the first await.
            const rows = readRows.all(source.source_path, SESSION_KIND_REVISION) as Candidate[];
            const before = new Map(rows.map((row) => [row.id, JSON.stringify(row)]));
            const generations = new Map(rows.map((row) => [row.native_id, sourceGeneration(store, 'codex', row.native_id)]));
            const authorized = (row: Candidate): boolean =>
                !isMemoryLocked(db) &&
                !store.consent.isRefusedForCapture(row.project_path) &&
                store.consent.isConsented(row.project_path) &&
                !store.isTranscriptPurged('codex', row.native_id) &&
                !store.isTranscriptIncognito('codex', row.native_id) &&
                sourceGeneration(store, 'codex', row.native_id) === generations.get(row.native_id);
            const currentRows = (): Map<number, Candidate> =>
                new Map((readRows.all(source.source_path, SESSION_KIND_REVISION) as Candidate[]).map((row) => [row.id, row]));
            const eligible = (): Candidate[] => {
                const current = currentRows();
                return rows.filter((row) => authorized(row) && JSON.stringify(current.get(row.id)) === before.get(row.id));
            };
            const incident = (reason: string): void => {
                summary.incidents++;
                options.warn?.(
                    `${SESSION_KIND_RECONCILIATION_LOG_PREFIX} ${stripShellSyntax(source.source_path)}: ${stripShellSyntax(reason)}; retry pending`,
                );
            };
            if (eligible().length === 0) {
                incident('source is not currently authorized');
                continue;
            }
            const opened = await openTranscript('codex', source.source_path);
            if ('reason' in opened) {
                incident(opened.reason);
                continue;
            }
            try {
                if (stopped()) {
                    break;
                }
                // Opening yields; a revoke there must prevent even the first
                // reader call. Header authorization precedes second-record
                // consumption, though the bounded reader may buffer its bytes.
                if (eligible().length === 0) {
                    incident('authorization or stored source changed after open');
                    continue;
                }
                const headerAuthorized = (cwd: string, nativeId: string): boolean =>
                    !store.consent.isRefusedForCapture(cwd) &&
                    store.consent.isConsented(cwd) &&
                    eligible().some((row) => row.native_id === nativeId);
                const preamble = await readCodexKindPreamble(opened.resolvedPath, opened.handle, headerAuthorized);
                if (preamble.malformed) {
                    summary.malformed++;
                    options.warn?.(
                        `${SESSION_KIND_RECONCILIATION_LOG_PREFIX} ${stripShellSyntax(source.source_path)}: malformed optional classification metadata ignored`,
                    );
                }
                // Filesystem checks finish before the short write transaction.
                const validate = sourceSnapshotValidator('codex', source.source_path, opened);
                if (stopped() || !validate()) {
                    incident('source changed or reconciliation cancelled');
                    continue;
                }
                const result = db.transaction(() => {
                    if (stopped() || !headerAuthorized(preamble.cwd, preamble.nativeId)) {
                        return undefined;
                    }
                    let reclassified = 0;
                    let checked = 0;
                    for (const row of eligible()) {
                        if (row.native_id !== preamble.nativeId) {
                            continue;
                        }
                        const kind = preamble.guardian ? 'adjudicator' : row.kind;
                        const changed = db
                            .prepare(`UPDATE sessions SET kind = ?, kind_revision = ?
                            WHERE id = ? AND kind IS ? AND kind_revision = ?`)
                            .run(kind, SESSION_KIND_REVISION, row.id, row.kind, row.kind_revision).changes;
                        if (changed !== 1) {
                            throw new Error('classification row changed during commit');
                        }
                        if (kind !== row.kind) {
                            reclassified++;
                        }
                        checked++;
                    }
                    return { checked, reclassified };
                })();
                if (result === undefined) {
                    incident('authorization or stored source changed');
                } else {
                    summary.checked += result.checked;
                    summary.reclassified += result.reclassified;
                    if (result.checked < rows.length) {
                        incident('some source segments are unauthorized, changed, or have mismatched identity');
                    }
                }
            } catch (error) {
                incident(errorMessage(error));
            } finally {
                await opened.handle.close();
            }
        }
        if (!stopped() && now() < deadline) {
            await yieldBatch();
        }
    }
    summary.pending = sessionKindStatus(db).pending;
    const hasMore =
        db
            .prepare(`SELECT 1 FROM sessions WHERE tool = 'codex'
        GROUP BY source_path HAVING MIN(id) > ? AND MIN(kind_revision) < ? LIMIT 1`)
            .get(afterId, SESSION_KIND_REVISION) !== undefined;
    if (options.continuation) {
        options.continuation.afterId = afterId;
        options.continuation.hasMore = hasMore && !stopped();
        options.continuation.incidents += summary.incidents;
    }
    save.run(
        SUMMARY_KEY,
        JSON.stringify({
            revision: SESSION_KIND_REVISION,
            ...summary,
            incidents: options.continuation?.incidents ?? summary.incidents,
            state: options.continuation?.hasMore ? 'scheduled' : summary.pending > 0 ? 'waiting' : 'complete',
        }),
    );
    options.log?.(
        `${SESSION_KIND_RECONCILIATION_LOG_PREFIX} ${summary.checked} checked, ${summary.reclassified} reclassified, ${summary.pending} pending, ${summary.incidents} incidents, ${summary.malformed} malformed optional metadata`,
    );
    return summary;
}
