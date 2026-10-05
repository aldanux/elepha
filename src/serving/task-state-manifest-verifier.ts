import { statSync } from 'node:fs';
import type Database from 'better-sqlite3-multiple-ciphers';
import {
    CURRENT_CHAT_EVIDENCE_MAX_PATH_BYTES,
    TASK_STATE_MANIFEST_MAX_SOURCE_TURNS,
    TASK_STATE_MANIFEST_VERIFY_DEADLINE_MS,
} from '../config/constants.js';
import { canonicalizeExisting, samePath } from '../config/paths.js';
import { escapeShellSyntax } from '../security/sanitize.js';
import { ConsentStore } from '../storage/consent-store.js';
import { retentionRemovedSql } from '../storage/live-memory-retention-schema.js';
import type {
    TaskStateManifestCoverage,
    TaskStateManifestInput,
    TaskStateManifestSection,
    TaskStateManifestSourceLocator,
} from '../storage/task-state-manifest-store.js';
import { TASK_STATE_MANIFEST_PROJECTION_ENCODING } from '../storage/task-state-manifest-store.js';
import type { TaskStateReportInput, ToolName } from '../types/index.js';
import { SessionReader } from './session-reader.js';

type PrecompactReport = Extract<TaskStateReportInput, { mode: 'precompact_manifest' }>;

interface SourceRow {
    memoryId: number;
    sessionId: number;
    projectId: number;
    memoryProjectId: number;
    turnIndex: number;
    segmentIndex: number;
    tool: ToolName;
    nativeId: string;
    sourcePath: string | null;
    projectPath: string | null;
    sourceDigest: string | null;
    sourceGeneration: number;
}

interface SourcePathCheckpoint {
    memoryId: number;
    sessionId: number;
    projectId: number;
    memoryProjectId: number;
    sourcePath: string;
    projectPath: string;
}

interface PreparationCheckpoint {
    rows: SourcePathCheckpoint[];
}

interface QuoteToVerify {
    section: TaskStateManifestSection;
    itemIndex: number;
    quoteIndex: number;
    role: 'user' | 'assistant';
    quote: string;
}

export type TaskStateManifestVerification =
    | { state: 'prepared'; manifest: TaskStateManifestInput; checkpoint: PreparationCheckpoint }
    | { state: 'unavailable'; reason: string };

function physicalDirectory(value: string): string | undefined {
    try {
        if (statSync(value).isDirectory()) {
            return canonicalizeExisting(value);
        }
    } catch {
        // A removed or substituted checkout cannot prove source scope.
    }
    return undefined;
}

function approvedPhysicalCheckout(consent: ConsentStore, value: string): string | undefined {
    if (consent.consentState(value) !== 'approved' || consent.isRefusedForCapture(value)) {
        return undefined;
    }
    return physicalDirectory(value);
}

function quotesIn(report: PrecompactReport): QuoteToVerify[] {
    const quotes: QuoteToVerify[] = [];
    const add = (section: TaskStateManifestSection, itemIndex: number, sources: { role: 'user' | 'assistant'; quote: string }[]) => {
        for (let quoteIndex = 0; quoteIndex < sources.length; quoteIndex++) {
            const source = sources[quoteIndex];
            if (source !== undefined) {
                quotes.push({ section, itemIndex, quoteIndex, ...source });
            }
        }
    };
    if (report.objective !== null) {
        add('objective', 0, report.objective.sources);
    }
    for (const section of ['decisions', 'constraints', 'pending_items'] as const) {
        report[section].forEach((item, itemIndex) => {
            add(section, itemIndex, item.sources);
        });
    }
    return quotes;
}

function quoteOffset(text: string, quote: string, source: 'durable' | 'transcript'): number {
    const escapedQuote = escapeShellSyntax(quote);
    if (source === 'durable') {
        return text.indexOf(escapedQuote);
    }
    const escapedText = escapeShellSyntax(text);
    let rawStart = text.indexOf(quote);
    while (rawStart >= 0) {
        const escapedStart = escapeShellSyntax(text.slice(0, rawStart)).length;
        if (escapedText.slice(escapedStart, escapedStart + escapedQuote.length) === escapedQuote) {
            return escapedStart;
        }
        rawStart = text.indexOf(quote, rawStart + 1);
    }
    return -1;
}

function sourceRows(db: Database.Database, reportingMemoryId: number, limit: number): SourceRow[] {
    return db
        .prepare(`WITH reporting AS (
        SELECT m.id AS memory_id, m.turn_index, s.tool, s.native_id, s.segment_index
        FROM memories m JOIN sessions s ON s.id = m.session_id
        WHERE m.id = ? AND s.kind = 'main'
    )
    SELECT m.id AS memoryId, s.id AS sessionId, s.project_id AS projectId,
        m.project_id AS memoryProjectId, m.turn_index AS turnIndex,
        s.segment_index AS segmentIndex, s.tool, s.native_id AS nativeId,
        CASE WHEN length(CAST(s.source_path AS BLOB)) <= ? THEN s.source_path END AS sourcePath,
        CASE WHEN length(CAST(p.path AS BLOB)) <= ? THEN p.path END AS projectPath,
        tsi.source_digest AS sourceDigest, COALESCE(g.generation, 0) AS sourceGeneration
    FROM reporting r JOIN sessions s ON s.tool = r.tool AND s.native_id = r.native_id
    JOIN projects p ON p.id = s.project_id
    JOIN memories m ON m.session_id = s.id
    LEFT JOIN turn_search_index tsi ON tsi.memory_id = m.id
    LEFT JOIN source_generations g ON g.tool = s.tool AND g.native_id = s.native_id
    WHERE s.kind = 'main'
      AND (s.segment_index < r.segment_index OR (s.segment_index = r.segment_index AND m.turn_index <= r.turn_index))
      AND NOT EXISTS (SELECT 1 FROM purged_transcripts t WHERE t.tool = s.tool AND t.native_id = s.native_id) AND NOT ${retentionRemovedSql('s.tool', 's.native_id')}
      AND NOT EXISTS (SELECT 1 FROM incognito_transcripts t WHERE t.tool = s.tool AND t.native_id = s.native_id)
    ORDER BY s.segment_index DESC, m.turn_index DESC LIMIT ?`)
        .all(reportingMemoryId, CURRENT_CHAT_EVIDENCE_MAX_PATH_BYTES, CURRENT_CHAT_EVIDENCE_MAX_PATH_BYTES, limit) as SourceRow[];
}

function sameSource(left: SourceRow, right: SourceRow): boolean {
    return (
        left.memoryId === right.memoryId &&
        left.sessionId === right.sessionId &&
        left.projectId === right.projectId &&
        left.memoryProjectId === right.memoryProjectId &&
        left.turnIndex === right.turnIndex &&
        left.segmentIndex === right.segmentIndex &&
        left.sourcePath === right.sourcePath &&
        left.projectPath === right.projectPath &&
        left.sourceDigest === right.sourceDigest &&
        left.sourceGeneration === right.sourceGeneration
    );
}

function pathCheckpoint(row: SourceRow): SourcePathCheckpoint | undefined {
    if (row.sourcePath === null || row.projectPath === null) {
        return undefined;
    }
    return {
        memoryId: row.memoryId,
        sessionId: row.sessionId,
        projectId: row.projectId,
        memoryProjectId: row.memoryProjectId,
        sourcePath: row.sourcePath,
        projectPath: row.projectPath,
    };
}

function matchesPathCheckpoint(row: SourceRow, checkpoint: SourcePathCheckpoint | undefined): boolean {
    return (
        checkpoint !== undefined &&
        row.memoryId === checkpoint.memoryId &&
        row.sessionId === checkpoint.sessionId &&
        row.projectId === checkpoint.projectId &&
        row.memoryProjectId === checkpoint.memoryProjectId &&
        row.sourcePath === checkpoint.sourcePath &&
        row.projectPath === checkpoint.projectPath &&
        row.projectId === row.memoryProjectId
    );
}

// The final writer calls this inside its short transaction after the async
// proof. It cannot repeat physical-path or transcript checks under a DB lock.
export function manifestSourcesStillCurrent(
    db: Database.Database,
    manifest: TaskStateManifestInput,
    checkpoint: PreparationCheckpoint,
): boolean {
    const source = manifest.reportingSource;
    const expectedIds = new Set([manifest.memoryId, ...manifest.sourceLocators.map((locator) => locator.sourceMemoryId)]);
    const checkpoints = new Map(checkpoint.rows.map((row) => [row.memoryId, row]));
    if (checkpoints.size !== expectedIds.size || checkpoint.rows.length !== expectedIds.size) {
        return false;
    }
    const rows = db.prepare(`SELECT m.id AS memoryId, s.id AS sessionId, m.turn_index AS turnIndex,
        s.tool, s.native_id AS nativeId, s.segment_index AS segmentIndex,
        s.project_id AS projectId, m.project_id AS memoryProjectId,
        s.source_path AS sourcePath, p.path AS projectPath,
        tsi.source_digest AS sourceDigest, COALESCE(g.generation, 0) AS sourceGeneration
        FROM memories m JOIN sessions s ON s.id = m.session_id JOIN projects p ON p.id = s.project_id
        LEFT JOIN turn_search_index tsi ON tsi.memory_id = m.id
        LEFT JOIN source_generations g ON g.tool = s.tool AND g.native_id = s.native_id
        WHERE m.id = ? AND s.kind = 'main'
          AND NOT EXISTS (SELECT 1 FROM purged_transcripts t WHERE t.tool = s.tool AND t.native_id = s.native_id) AND NOT ${retentionRemovedSql('s.tool', 's.native_id')}
          AND NOT EXISTS (SELECT 1 FROM incognito_transcripts t WHERE t.tool = s.tool AND t.native_id = s.native_id)`) as Database.Statement;
    const reporting = rows.get(manifest.memoryId) as SourceRow | undefined;
    if (
        reporting === undefined ||
        !matchesPathCheckpoint(reporting, checkpoints.get(manifest.memoryId)) ||
        reporting.sessionId !== source.sessionId ||
        reporting.turnIndex !== source.turnIndex ||
        reporting.sourceGeneration !== source.sourceGeneration ||
        reporting.sourceDigest !== source.sourceDigest
    ) {
        return false;
    }
    for (const locator of manifest.sourceLocators) {
        const current = rows.get(locator.sourceMemoryId) as SourceRow | undefined;
        if (
            current === undefined ||
            !matchesPathCheckpoint(current, checkpoints.get(locator.sourceMemoryId)) ||
            current.sessionId !== locator.sourceSessionId ||
            current.turnIndex !== locator.sourceTurnIndex ||
            current.sourceGeneration !== locator.sourceGeneration ||
            current.sourceDigest !== locator.sourceDigest ||
            current.tool !== reporting.tool ||
            current.nativeId !== reporting.nativeId ||
            current.segmentIndex > reporting.segmentIndex ||
            (current.segmentIndex === reporting.segmentIndex && current.turnIndex > reporting.turnIndex) ||
            (current.memoryId === reporting.memoryId && locator.role === 'assistant')
        ) {
            return false;
        }
    }
    return true;
}

// Preparation is read-only. The caller inserts only after this async source
// proof completes; no provider I/O or awaited work belongs in its transaction.
export async function verifyTaskStateManifest(
    db: Database.Database,
    input: { reportingMemoryId: number; report: PrecompactReport; cwd: string; createdAt?: string },
    reader: Pick<SessionReader, 'indexedTurnEvidence'> = new SessionReader(db),
    signal?: AbortSignal,
): Promise<TaskStateManifestVerification> {
    const consent = new ConsentStore(db);
    const checkout = approvedPhysicalCheckout(consent, input.cwd);
    if (checkout === undefined) {
        return { state: 'unavailable', reason: 'checkout_not_consented' };
    }
    const rows = sourceRows(db, input.reportingMemoryId, TASK_STATE_MANIFEST_MAX_SOURCE_TURNS + 1);
    const reporting = rows[0];
    if (reporting === undefined || reporting.memoryId !== input.reportingMemoryId) {
        return { state: 'unavailable', reason: 'reporting_turn_unavailable' };
    }
    if (!reporting.sourceDigest || !/^[a-f0-9]{64}$/.test(reporting.sourceDigest)) {
        return { state: 'unavailable', reason: 'reporting_source_digest_unavailable' };
    }
    if (
        reporting.projectPath === null ||
        reporting.sourcePath === null ||
        !samePath(physicalDirectory(reporting.projectPath) ?? '', checkout)
    ) {
        return { state: 'unavailable', reason: 'reporting_checkout_mismatch' };
    }
    const quotes = quotesIn(input.report);
    const unresolved = new Set(quotes.map((_, index) => index));
    const locators: TaskStateManifestSourceLocator[] = [];
    let firstGap: string | undefined;
    const deadline = AbortSignal.timeout(TASK_STATE_MANIFEST_VERIFY_DEADLINE_MS);
    const readSignal = signal === undefined ? deadline : AbortSignal.any([signal, deadline]);
    for (const row of rows.slice(0, TASK_STATE_MANIFEST_MAX_SOURCE_TURNS)) {
        if (unresolved.size === 0) {
            break;
        }
        if (readSignal.aborted) {
            firstGap ??= 'deadline';
            break;
        }
        if (row.projectPath === null || row.sourcePath === null) {
            firstGap ??= 'source_metadata_exceeds_budget';
            continue;
        }
        const sourceCheckout = approvedPhysicalCheckout(consent, row.projectPath);
        if (sourceCheckout === undefined || !samePath(sourceCheckout, checkout)) {
            continue;
        }
        if (!row.sourceDigest || !/^[a-f0-9]{64}$/.test(row.sourceDigest)) {
            firstGap ??= 'source_digest_unavailable';
            continue;
        }
        const evidence = await reader.indexedTurnEvidence(
            {
                id: row.sessionId,
                tool: row.tool,
                native_id: row.nativeId,
                source_path: row.sourcePath,
                expectedProjectPath: row.projectPath,
            },
            row.turnIndex,
            readSignal,
        );
        if (evidence.state === 'unavailable') {
            firstGap ??= evidence.reason;
            continue;
        }
        for (const index of unresolved) {
            const source = quotes[index];
            if (source === undefined || (row.memoryId === reporting.memoryId && source.role === 'assistant')) {
                continue;
            }
            const text = source.role === 'user' ? evidence.projection.userPrompt : evidence.projection.assistantResponse;
            const start = quoteOffset(text, source.quote, evidence.source);
            if (start < 0) {
                continue;
            }
            locators.push({
                section: source.section,
                itemIndex: source.itemIndex,
                quoteIndex: source.quoteIndex,
                sourceMemoryId: row.memoryId,
                sourceSessionId: row.sessionId,
                sourceTurnIndex: row.turnIndex,
                sourceGeneration: row.sourceGeneration,
                sourceDigest: row.sourceDigest,
                role: source.role,
                projectionEncoding: TASK_STATE_MANIFEST_PROJECTION_ENCODING,
                evidenceSource: evidence.source,
                start,
                end: start + escapeShellSyntax(source.quote).length,
            });
            unresolved.delete(index);
        }
    }
    const currentCheckout = approvedPhysicalCheckout(consent, input.cwd);
    if (currentCheckout === undefined || !samePath(currentCheckout, checkout)) {
        return { state: 'unavailable', reason: 'checkout_authorization_changed' };
    }
    const refreshed = sourceRows(db, input.reportingMemoryId, TASK_STATE_MANIFEST_MAX_SOURCE_TURNS + 1);
    const selectedRows = [reporting, ...locators.map((locator) => rows.find((candidate) => candidate.memoryId === locator.sourceMemoryId))];
    for (const row of selectedRows) {
        if (
            row === undefined ||
            row.projectPath === null ||
            !samePath(approvedPhysicalCheckout(consent, row.projectPath) ?? '', checkout) ||
            !refreshed.some((candidate) => sameSource(candidate, row))
        ) {
            return { state: 'unavailable', reason: 'source_authorization_changed' };
        }
    }
    const checkpoints = new Map<number, SourcePathCheckpoint>();
    for (const row of selectedRows) {
        const checkpoint = row === undefined ? undefined : pathCheckpoint(row);
        if (checkpoint === undefined) {
            return { state: 'unavailable', reason: 'source_metadata_exceeds_budget' };
        }
        checkpoints.set(checkpoint.memoryId, checkpoint);
    }
    const coverage: TaskStateManifestCoverage =
        unresolved.size === 0 && quotes.length > 0
            ? { state: 'verified', resolvedSourceCount: locators.length, totalSourceCount: quotes.length }
            : {
                  state: 'incomplete',
                  resolvedSourceCount: locators.length,
                  totalSourceCount: quotes.length,
                  reason:
                      quotes.length === 0
                          ? 'no_source_backed_items'
                          : readSignal.aborted
                            ? 'deadline'
                            : (firstGap ??
                              (rows.length > TASK_STATE_MANIFEST_MAX_SOURCE_TURNS ? 'older_sources_not_scanned' : 'exact_quote_not_found')),
              };
    return {
        state: 'prepared',
        checkpoint: { rows: [...checkpoints.values()] },
        manifest: {
            memoryId: reporting.memoryId,
            report: input.report,
            reportingSource: {
                sessionId: reporting.sessionId,
                turnIndex: reporting.turnIndex,
                sourceGeneration: reporting.sourceGeneration,
                sourceDigest: reporting.sourceDigest,
            },
            sourceLocators: locators,
            coverage,
            createdAt: input.createdAt ?? new Date().toISOString(),
        },
    };
}
