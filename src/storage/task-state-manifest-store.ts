import type { Database, Statement } from 'better-sqlite3-multiple-ciphers';
import { parseTaskStateReportInput } from '../adapters/task-state-report.js';
import {
    TASK_STATE_MANIFEST_TIMESTAMP_MAX_BYTES,
    TASK_STATE_REPORT_INPUT_MAX_BYTES,
    TASK_STATE_REPORT_ITEM_MAX_CHARS,
} from '../config/constants.js';
import { escapeShellSyntax } from '../security/sanitize.js';
import type { TaskStateReportInput, TaskStateReportPrecompactItem } from '../types/index.js';
import { runSessionLiveMemoryWrite } from './live-memory-retention.js';

export type TaskStateManifestSection = 'objective' | 'decisions' | 'constraints' | 'pending_items';
export const TASK_STATE_MANIFEST_PROJECTION_ENCODING = 'filtered_escaped_v1' as const;

export interface TaskStateManifestReportingSource {
    sessionId: number;
    turnIndex: number;
    sourceGeneration: number;
    sourceDigest: string;
}

// Offsets address UTF-16 code units in the escaped filtered role projection.
// The stored quote equals that projection's slice(start, end); the digest and
// generation let a reader detect source replacement before trusting the slice.
export interface TaskStateManifestSourceLocator {
    section: TaskStateManifestSection;
    itemIndex: number;
    quoteIndex: number;
    sourceMemoryId: number;
    sourceSessionId: number;
    sourceTurnIndex: number;
    sourceGeneration: number;
    sourceDigest: string;
    role: 'user' | 'assistant';
    projectionEncoding: typeof TASK_STATE_MANIFEST_PROJECTION_ENCODING;
    evidenceSource: 'durable' | 'transcript';
    start: number;
    end: number;
}

// The source reader establishes quote truth before calling insert. This store
// enforces complete, unique locator coverage but cannot re-read transcripts.
export type TaskStateManifestCoverage =
    | { state: 'verified'; resolvedSourceCount: number; totalSourceCount: number }
    | { state: 'incomplete'; resolvedSourceCount: number; totalSourceCount: number; reason: string };

export interface TaskStateManifestInput {
    memoryId: number;
    report: Extract<TaskStateReportInput, { mode: 'precompact_manifest' }>;
    reportingSource: TaskStateManifestReportingSource;
    sourceLocators: TaskStateManifestSourceLocator[];
    coverage: TaskStateManifestCoverage;
    createdAt: string;
}

export interface TaskStateManifestRow extends TaskStateManifestInput {}

interface RawManifestRow {
    memory_id: number;
    report: string;
    reporting_source: string;
    source_locators: string;
    coverage_state: 'verified' | 'incomplete';
    resolved_source_count: number;
    total_source_count: number;
    coverage_reason: string | null;
    created_at: string;
}

function wholeNumber(value: number, minimum: number): boolean {
    return Number.isSafeInteger(value) && value >= minimum;
}

function validDigest(value: string): boolean {
    return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function itemAt(
    report: TaskStateManifestInput['report'],
    section: TaskStateManifestSection,
    index: number,
): TaskStateReportPrecompactItem | undefined {
    if (section === 'objective') {
        return index === 0 ? (report.objective ?? undefined) : undefined;
    }
    return section === 'decisions' || section === 'constraints' || section === 'pending_items' ? report[section][index] : undefined;
}

function allQuotes(report: TaskStateManifestInput['report']): number {
    const items = [report.objective, ...report.decisions, ...report.constraints, ...report.pending_items];
    return items.reduce((total, item) => total + (item?.sources.length ?? 0), 0);
}

export function validateTaskStateManifest(input: TaskStateManifestInput): void {
    if (
        input.reportingSource === null ||
        typeof input.reportingSource !== 'object' ||
        input.coverage === null ||
        typeof input.coverage !== 'object' ||
        !Array.isArray(input.sourceLocators)
    ) {
        throw new Error('Invalid task-state manifest metadata');
    }
    const parsed = parseTaskStateReportInput(input.report);
    if (parsed.state !== 'complete' || parsed.input.mode !== 'precompact_manifest') {
        throw new Error('Invalid precompact task-state report');
    }
    const source = input.reportingSource;
    if (
        !wholeNumber(input.memoryId, 1) ||
        !wholeNumber(source.sessionId, 1) ||
        !wholeNumber(source.turnIndex, 0) ||
        !wholeNumber(source.sourceGeneration, 0) ||
        !validDigest(source.sourceDigest)
    ) {
        throw new Error('Invalid task-state reporting source');
    }
    if (
        typeof input.createdAt !== 'string' ||
        Buffer.byteLength(input.createdAt) > TASK_STATE_MANIFEST_TIMESTAMP_MAX_BYTES ||
        !Number.isFinite(Date.parse(input.createdAt)) ||
        new Date(input.createdAt).toISOString() !== input.createdAt
    ) {
        throw new Error('Invalid task-state creation time');
    }
    const total = allQuotes(input.report);
    if (
        !wholeNumber(input.coverage.totalSourceCount, 0) ||
        input.coverage.totalSourceCount !== total ||
        !wholeNumber(input.coverage.resolvedSourceCount, 0) ||
        input.coverage.resolvedSourceCount !== input.sourceLocators.length ||
        input.coverage.resolvedSourceCount > total ||
        input.sourceLocators.length > total
    ) {
        throw new Error('Invalid task-state source coverage');
    }
    if (input.coverage.state !== 'verified' && input.coverage.state !== 'incomplete') {
        throw new Error('Invalid task-state verification state');
    }
    if (
        (input.coverage.state === 'verified' && (total === 0 || input.coverage.resolvedSourceCount !== total)) ||
        (input.coverage.state === 'incomplete' &&
            (typeof input.coverage.reason !== 'string' ||
                !input.coverage.reason.trim() ||
                input.coverage.reason.length > TASK_STATE_REPORT_ITEM_MAX_CHARS))
    ) {
        throw new Error('Invalid task-state verification state');
    }
    const coordinates = new Set<string>();
    for (const locator of input.sourceLocators) {
        const quote = itemAt(input.report, locator.section, locator.itemIndex)?.sources[locator.quoteIndex];
        const coordinate = `${locator.section}:${locator.itemIndex}:${locator.quoteIndex}`;
        if (
            !quote ||
            coordinates.has(coordinate) ||
            locator.role !== quote.role ||
            locator.projectionEncoding !== TASK_STATE_MANIFEST_PROJECTION_ENCODING ||
            (locator.evidenceSource !== 'durable' && locator.evidenceSource !== 'transcript') ||
            !wholeNumber(locator.itemIndex, 0) ||
            !wholeNumber(locator.quoteIndex, 0) ||
            !wholeNumber(locator.sourceMemoryId, 1) ||
            !wholeNumber(locator.sourceSessionId, 1) ||
            !wholeNumber(locator.sourceTurnIndex, 0) ||
            !wholeNumber(locator.sourceGeneration, 0) ||
            !validDigest(locator.sourceDigest) ||
            !wholeNumber(locator.start, 0) ||
            !wholeNumber(locator.end, locator.start + 1) ||
            locator.end - locator.start !== escapeShellSyntax(quote.quote).length
        ) {
            throw new Error('Invalid task-state source locator');
        }
        coordinates.add(coordinate);
    }
}

function sanitizeItem(item: TaskStateReportPrecompactItem): TaskStateReportPrecompactItem {
    return {
        text: escapeShellSyntax(item.text),
        sources: item.sources.map((source) => ({ role: source.role, quote: escapeShellSyntax(source.quote) })),
    };
}

function preparedInput(input: TaskStateManifestInput): TaskStateManifestInput {
    validateTaskStateManifest(input);
    const report = input.report;
    const cleaned: TaskStateManifestInput = {
        memoryId: input.memoryId,
        report: {
            mode: 'precompact_manifest',
            request_id: report.request_id,
            objective: report.objective === null ? null : sanitizeItem(report.objective),
            decisions: report.decisions.map(sanitizeItem),
            constraints: report.constraints.map(sanitizeItem),
            pending_items: report.pending_items.map(sanitizeItem),
        },
        reportingSource: {
            sessionId: input.reportingSource.sessionId,
            turnIndex: input.reportingSource.turnIndex,
            sourceGeneration: input.reportingSource.sourceGeneration,
            sourceDigest: input.reportingSource.sourceDigest,
        },
        sourceLocators: input.sourceLocators
            .map((locator) => ({
                section: locator.section,
                itemIndex: locator.itemIndex,
                quoteIndex: locator.quoteIndex,
                sourceMemoryId: locator.sourceMemoryId,
                sourceSessionId: locator.sourceSessionId,
                sourceTurnIndex: locator.sourceTurnIndex,
                sourceGeneration: locator.sourceGeneration,
                sourceDigest: locator.sourceDigest,
                role: locator.role,
                projectionEncoding: locator.projectionEncoding,
                evidenceSource: locator.evidenceSource,
                start: locator.start,
                end: locator.end,
            }))
            .sort((left, right) =>
                `${left.section}:${left.itemIndex}:${left.quoteIndex}`.localeCompare(
                    `${right.section}:${right.itemIndex}:${right.quoteIndex}`,
                ),
            ),
        coverage:
            input.coverage.state === 'incomplete'
                ? {
                      state: 'incomplete',
                      resolvedSourceCount: input.coverage.resolvedSourceCount,
                      totalSourceCount: input.coverage.totalSourceCount,
                      reason: escapeShellSyntax(input.coverage.reason),
                  }
                : {
                      state: 'verified',
                      resolvedSourceCount: input.coverage.resolvedSourceCount,
                      totalSourceCount: input.coverage.totalSourceCount,
                  },
        createdAt: input.createdAt,
    };
    const cleanedReport = parseTaskStateReportInput(cleaned.report);
    if (
        cleanedReport.state !== 'complete' ||
        Buffer.byteLength(JSON.stringify(cleaned.report)) > TASK_STATE_REPORT_INPUT_MAX_BYTES ||
        Buffer.byteLength(JSON.stringify(cleaned.sourceLocators)) > TASK_STATE_REPORT_INPUT_MAX_BYTES ||
        (cleaned.coverage.state === 'incomplete' && cleaned.coverage.reason.length > TASK_STATE_REPORT_ITEM_MAX_CHARS)
    ) {
        throw new Error('Task-state manifest exceeds storage bound');
    }
    return cleaned;
}

function decode(row: RawManifestRow): TaskStateManifestRow {
    const coverage: TaskStateManifestCoverage =
        row.coverage_state === 'verified'
            ? { state: 'verified', resolvedSourceCount: row.resolved_source_count, totalSourceCount: row.total_source_count }
            : {
                  state: 'incomplete',
                  resolvedSourceCount: row.resolved_source_count,
                  totalSourceCount: row.total_source_count,
                  reason: row.coverage_reason ?? 'unknown',
              };
    return {
        memoryId: row.memory_id,
        report: JSON.parse(row.report),
        reportingSource: JSON.parse(row.reporting_source),
        sourceLocators: JSON.parse(row.source_locators),
        coverage,
        createdAt: row.created_at,
    };
}

export class TaskStateManifestStore {
    private readonly getStatement: Statement;
    private readonly insertStatement: Statement;
    private readonly deleteStatement: Statement;
    private readonly reportingMemoryStatement: Statement;

    constructor(private readonly db: Database) {
        this.getStatement = db.prepare('SELECT * FROM task_state_manifests WHERE memory_id = ?');
        this.insertStatement = db.prepare(`INSERT INTO task_state_manifests
            (memory_id, report, reporting_source, source_locators, coverage_state,
             resolved_source_count, total_source_count, coverage_reason, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
        this.deleteStatement = db.prepare('DELETE FROM task_state_manifests WHERE memory_id = ?');
        this.reportingMemoryStatement = db.prepare('SELECT session_id, turn_index FROM memories WHERE id = ?');
    }

    get(memoryId: number): TaskStateManifestRow | undefined {
        const row = this.getStatement.get(memoryId) as RawManifestRow | undefined;
        return row === undefined ? undefined : decode(row);
    }

    insert(input: TaskStateManifestInput): 'inserted' | 'already-present' {
        const prepared = preparedInput(input);
        const insert = this.db.transaction(() => {
            const reportingMemory = this.reportingMemoryStatement.get(prepared.memoryId) as
                | { session_id: number; turn_index: number }
                | undefined;
            if (
                reportingMemory === undefined ||
                reportingMemory.session_id !== prepared.reportingSource.sessionId ||
                reportingMemory.turn_index !== prepared.reportingSource.turnIndex
            ) {
                throw new Error('Task-state reporting turn does not match its memory');
            }
            const existing = this.get(prepared.memoryId);
            if (existing !== undefined) {
                if (
                    JSON.stringify(existing.report) !== JSON.stringify(prepared.report) ||
                    JSON.stringify(existing.reportingSource) !== JSON.stringify(prepared.reportingSource) ||
                    JSON.stringify(existing.sourceLocators) !== JSON.stringify(prepared.sourceLocators) ||
                    JSON.stringify(existing.coverage) !== JSON.stringify(prepared.coverage)
                ) {
                    throw new Error('Conflicting task-state manifest for memory');
                }
                return 'already-present';
            }

            this.insertStatement.run(
                prepared.memoryId,
                JSON.stringify(prepared.report),
                JSON.stringify(prepared.reportingSource),
                JSON.stringify(prepared.sourceLocators),
                prepared.coverage.state,
                prepared.coverage.resolvedSourceCount,
                prepared.coverage.totalSourceCount,
                prepared.coverage.state === 'incomplete' ? prepared.coverage.reason : null,
                prepared.createdAt,
            );

            return 'inserted';
        });
        return runSessionLiveMemoryWrite(this.db, prepared.reportingSource.sessionId, () => insert());
    }

    delete(memoryId: number): boolean {
        return this.db.transaction(() => this.deleteStatement.run(memoryId).changes > 0)();
    }
}
