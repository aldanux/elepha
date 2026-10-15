import { statSync } from 'node:fs';
import type Database from 'better-sqlite3-multiple-ciphers';
import { CodexAdapter, readCodexKindPreamble } from '../adapters/codex.js';
import { sameTaskStateReportInput } from '../adapters/task-state-report.js';
import { CODEX_TASK_SOURCE_KIND } from '../config/codex.js';
import {
    CURRENT_CHAT_EVIDENCE_MAX_PATH_BYTES,
    SESSION_KIND_PREAMBLE_MAX_BYTES,
    TASK_STATE_MANIFEST_MAX_SOURCE_TURNS,
    TASK_STATE_MANIFEST_VERIFY_DEADLINE_MS,
} from '../config/constants.js';
import { canonicalizeExisting, samePath } from '../config/paths.js';
import { filterTurn } from '../rendering/filtered-turn.js';
import type { OpenedProviderTranscript } from '../security/provider-transcript.js';
import { escapeShellSyntax } from '../security/sanitize.js';
import { containsSentinel } from '../security/sentinel.js';
import { ConsentStore } from '../storage/consent-store.js';
import { InjectionStore } from '../storage/injection-store.js';
import { retentionRemovedSql } from '../storage/live-memory-retention-schema.js';
import { readTaskSourcePosition } from '../storage/session-read-model.js';
import { decodeResumeContext } from '../storage/source-resume-context.js';
import { sourceTurnDigests } from '../storage/source-turn-digest.js';
import type {
    TaskStateManifestCoverage,
    TaskStateManifestInput,
    TaskStateManifestSection,
    TaskStateManifestSourceLocator,
} from '../storage/task-state-manifest-store.js';
import { TASK_STATE_MANIFEST_PROJECTION_ENCODING } from '../storage/task-state-manifest-store.js';
import {
    prepareTaskStateProjectScope,
    type TaskStateProjectScope,
    taskStateProjectScopeCurrent,
} from '../storage/task-state-project-scope.js';
import type {
    ParsedTurn,
    SessionAdapter,
    SourceReadBudget,
    TaskStateNativeSourceProof,
    TaskStateReportInput,
    ToolName,
} from '../types/index.js';
import { SessionReader } from './session-reader.js';
import { authenticateTaskStateChat } from './task-state-chat.js';

type PrecompactReport = Extract<TaskStateReportInput, { mode: 'precompact_manifest' }>;

// Recovery already replayed this reporting turn against retained coverage.
// Borrow its opened source and pass allowance; the publisher owns final checks.
export interface TaskStateReportingEvidence {
    turn: ParsedTurn;
    adapter: SessionAdapter;
    opened: OpenedProviderTranscript;
    sourcePath: string;
    readBudget: SourceReadBudget;
    current: () => boolean;
}

export async function readTaskStateNativeSources(
    db: Database.Database,
    input: { memoryId: number; nativeId: string; cwd: string; report: PrecompactReport; sourceDigest: string },
    signal: AbortSignal,
    onSource: (text: string, proof: TaskStateNativeSourceProof, timestampMs?: number) => void,
    sharedChat?: NonNullable<Awaited<ReturnType<typeof authenticateTaskStateChat>>>,
    recovered?: TaskStateReportingEvidence,
): Promise<{ state: 'available'; assistantBeforeMs?: number } | { state: 'unavailable'; reason: string }> {
    const unavailable = (reason: string) => ({ state: 'unavailable' as const, reason });
    const ownedChat =
        !sharedChat && !recovered
            ? await authenticateTaskStateChat(db, { tool: 'codex', nativeSessionId: input.nativeId, cwd: input.cwd, signal })
            : undefined;
    const liveChat = sharedChat ?? ownedChat;
    const chat =
        recovered ??
        (liveChat && {
            adapter: liveChat.adapter,
            opened: liveChat.opened,
            sourcePath: liveChat.binding.sourcePath,
            readBudget: liveChat.readBudget,
            current: liveChat.current,
        });
    if (!chat || !(chat.adapter instanceof CodexAdapter)) {
        return unavailable('native_chat_unavailable');
    }
    try {
        const position = readTaskSourcePosition(db, 'codex', input.nativeId, input.memoryId);
        if (!position || (position.turnIndex > 0 && !position.beforeCursor)) {
            return unavailable('native_source_cursor_unavailable');
        }
        const start = position.beforeCursor ? chat.adapter.cursorPosition(position.beforeCursor).byteOffset : 0;
        const end = chat.adapter.cursorPosition(position.cursor).byteOffset;
        if (start === undefined || end === undefined) {
            return unavailable('native_source_cursor_unavailable');
        }
        let reporting: ParsedTurn | undefined = recovered?.turn;
        let invalid = false;
        if (!reporting) {
            for await (const turn of chat.adapter.parseTurns(chat.sourcePath, position.beforeCursor ?? undefined, {
                handle: chat.opened.handle,
                readBudget: chat.readBudget,
                signal,
                endByteOffset: end,
                includeClosingBoundary: true,
                closeTrailingOnIdle: true,
                skipSessionTitle: true,
                resumeContext: decodeResumeContext(position.beforeContext),
                onDesync: () => {
                    invalid = true;
                },
                onMalformedRecords: () => {
                    invalid = true;
                },
                onUnrecognizedRecords: () => {
                    invalid = true;
                },
            })) {
                if (turn.turnIndex === position.turnIndex) {
                    reporting = turn;
                }
            }
        }
        const injections = new InjectionStore(db);
        if (
            invalid ||
            !reporting ||
            reporting.tool !== 'codex' ||
            reporting.sessionId !== input.nativeId ||
            reporting.turnIndex !== position.turnIndex ||
            !chat.current() ||
            reporting.droppedReason !== undefined ||
            !sourceTurnDigests(reporting).includes(input.sourceDigest) ||
            chat.adapter.cursorPosition(reporting.cursor).byteOffset !== end ||
            !samePath(canonicalizeExisting(reporting.projectPath), canonicalizeExisting(input.cwd)) ||
            !reporting.taskStateReport ||
            !sameTaskStateReportInput(reporting.taskStateReport, input.report) ||
            injections.quoteBackStatus(reporting) !== 'no-match'
        ) {
            return unavailable('native_reporting_source_changed');
        }
        if (recovered) {
            const header = await readCodexKindPreamble(
                chat.sourcePath,
                chat.opened.handle,
                (cwd, nativeId) => nativeId === input.nativeId && samePath(canonicalizeExisting(cwd), canonicalizeExisting(input.cwd)),
                { readBudget: chat.readBudget, signal },
            );
            if (header.malformed || header.guardian || !header.root) {
                return unavailable('native_chat_unavailable');
            }
            const classification = await chat.adapter.classifySession(chat.sourcePath, {
                handle: chat.opened.handle,
                readBudget: chat.readBudget,
                signal,
                maxReadBytes: SESSION_KIND_PREAMBLE_MAX_BYTES,
            });
            if (classification.kind !== 'primary' || classification.exclusion !== undefined) {
                return unavailable('native_chat_unavailable');
            }
        }
        const reportCallId = reporting.taskStateReport.callId;
        const accepted = (text: string, proof: TaskStateNativeSourceProof, timestampMs?: number) => {
            if (
                containsSentinel(text) ||
                injections.quoteBackStatus({
                    tool: 'codex',
                    sessionId: input.nativeId,
                    turnIndex: reporting.turnIndex,
                    endedAt: reporting.endedAt,
                    userMessage: proof.kind === CODEX_TASK_SOURCE_KIND.projectInstructions ? text : '',
                    assistantText: proof.kind === CODEX_TASK_SOURCE_KIND.assistantBeforeReport ? text : '',
                    toolCalls: [],
                }) !== 'no-match'
            ) {
                return;
            }
            const filtered = filterTurn({ userMessage: '', assistantText: text, toolCalls: [] }).assistantResponse;
            onSource(filtered, proof, timestampMs);
        };
        const options = {
            handle: chat.opened.handle,
            readBudget: chat.readBudget,
            signal,
            reportCallId,
            authorizeCwd: (cwd: string) => samePath(canonicalizeExisting(cwd), canonicalizeExisting(input.cwd)),
            onSource: accepted,
        };
        if (!(await chat.adapter.readInitialTaskContext(chat.sourcePath, options))) {
            return unavailable('native_context_unavailable');
        }
        const matchedCall = await chat.adapter.readAssistantBeforeTaskReport(chat.sourcePath, {
            ...options,
            start,
            end,
            report: reporting.taskStateReport,
        });
        if (signal.aborted) {
            return unavailable('deadline');
        }
        if (!matchedCall) {
            return unavailable('native_report_order_unavailable');
        }
        return chat.current() ? { state: 'available', ...matchedCall } : unavailable('native_source_changed');
    } catch {
        return unavailable(signal.aborted ? 'deadline' : 'native_source_read_unavailable');
    } finally {
        await ownedChat?.close();
    }
}

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
    projects: TaskStateProjectScope[];
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
    if (checkpoint.projects.some((project) => !taskStateProjectScopeCurrent(db, project))) {
        return false;
    }
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
            (current.memoryId === reporting.memoryId &&
                locator.role === 'assistant' &&
                locator.nativeSource?.kind !== CODEX_TASK_SOURCE_KIND.assistantBeforeReport)
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
    reportingEvidence?: TaskStateReportingEvidence,
): Promise<TaskStateManifestVerification> {
    const consent = new ConsentStore(db);
    const checkout = approvedPhysicalCheckout(consent, input.cwd);
    if (checkout === undefined) {
        return { state: 'unavailable', reason: 'checkout_not_consented' };
    }
    const rows = sourceRows(db, input.reportingMemoryId, TASK_STATE_MANIFEST_MAX_SOURCE_TURNS + 1);
    const projects = new Map<number, TaskStateProjectScope>();
    const authorizedProject = (row: SourceRow): boolean => {
        if (row.projectPath === null) {
            return false;
        }
        let project = projects.get(row.projectId);
        if (project === undefined) {
            project = prepareTaskStateProjectScope(db, row.projectId, row.projectPath, checkout);
            if (project === undefined) {
                return false;
            }
            projects.set(row.projectId, project);
        }
        return (
            row.projectPath === project.projectPath &&
            samePath(physicalDirectory(row.projectPath) ?? '', project.canonicalPaths.get(row.projectPath) ?? '') &&
            taskStateProjectScopeCurrent(db, project)
        );
    };
    const reporting = rows[0];
    if (reporting === undefined || reporting.memoryId !== input.reportingMemoryId) {
        return { state: 'unavailable', reason: 'reporting_turn_unavailable' };
    }
    if (!reporting.sourceDigest || !/^[a-f0-9]{64}$/.test(reporting.sourceDigest)) {
        return { state: 'unavailable', reason: 'reporting_source_digest_unavailable' };
    }
    if (reporting.projectPath === null || reporting.sourcePath === null || !authorizedProject(reporting)) {
        return { state: 'unavailable', reason: 'reporting_checkout_mismatch' };
    }
    const quotes = quotesIn(input.report);
    const unresolved = new Set(quotes.map((_, index) => index));
    const locators: TaskStateManifestSourceLocator[] = [];
    let firstGap: string | undefined;
    const deadline = AbortSignal.timeout(TASK_STATE_MANIFEST_VERIFY_DEADLINE_MS);
    const readSignal = signal === undefined ? deadline : AbortSignal.any([signal, deadline]);
    // An empty replacement still needs authenticated reporting evidence;
    // absence of quotes alone never authorizes withdrawal.
    if (quotes.length === 0) {
        const evidence = await reader.indexedTurnEvidence(
            {
                id: reporting.sessionId,
                tool: reporting.tool,
                native_id: reporting.nativeId,
                source_path: reporting.sourcePath,
                expectedProjectPath: reporting.projectPath,
            },
            reporting.turnIndex,
            readSignal,
        );
        if (evidence.state !== 'available' || readSignal.aborted) {
            return { state: 'unavailable', reason: evidence.state === 'unavailable' ? evidence.reason : 'deadline' };
        }
    }
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
        if (!authorizedProject(row)) {
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
    if (rows.length > TASK_STATE_MANIFEST_MAX_SOURCE_TURNS) {
        firstGap ??= 'older_sources_not_scanned';
    }
    if (
        reporting.tool === 'codex' &&
        [...unresolved].some(
            (index) => quotes[index]?.role === 'assistant' || (quotes[index]?.section === 'constraints' && quotes[index]?.role === 'user'),
        )
    ) {
        const candidates = new Map<number, { locator: TaskStateManifestSourceLocator; timestampMs?: number }>();
        const complete = await readTaskStateNativeSources(
            db,
            {
                memoryId: reporting.memoryId,
                nativeId: reporting.nativeId,
                cwd: input.cwd,
                report: input.report,
                sourceDigest: reporting.sourceDigest,
            },
            readSignal,
            (text, proof, timestampMs) => {
                for (const index of unresolved) {
                    const source = quotes[index];
                    if (
                        source === undefined ||
                        candidates.has(index) ||
                        (proof.kind === CODEX_TASK_SOURCE_KIND.projectInstructions
                            ? source.section !== 'constraints' || source.role !== 'user'
                            : source.role !== 'assistant')
                    ) {
                        continue;
                    }
                    const start = quoteOffset(text, source.quote, 'transcript');
                    if (start < 0) {
                        continue;
                    }
                    candidates.set(index, {
                        timestampMs,
                        locator: {
                            section: source.section,
                            itemIndex: source.itemIndex,
                            quoteIndex: source.quoteIndex,
                            sourceMemoryId: reporting.memoryId,
                            sourceSessionId: reporting.sessionId,
                            sourceTurnIndex: reporting.turnIndex,
                            sourceGeneration: reporting.sourceGeneration,
                            sourceDigest: reporting.sourceDigest as string,
                            role: source.role,
                            projectionEncoding: TASK_STATE_MANIFEST_PROJECTION_ENCODING,
                            evidenceSource: 'transcript',
                            start,
                            end: start + escapeShellSyntax(source.quote).length,
                            nativeSource: proof,
                        },
                    });
                }
            },
            undefined,
            reportingEvidence,
        );
        if (complete.state === 'available') {
            for (const [index, { locator, timestampMs }] of candidates) {
                // Desktop emits the envelope at completion; only native timestamps
                // strictly before invocation establish pre-report assistant evidence.
                if (
                    locator.nativeSource?.kind === CODEX_TASK_SOURCE_KIND.assistantBeforeReport &&
                    complete.assistantBeforeMs !== undefined &&
                    (timestampMs === undefined || !Number.isFinite(timestampMs) || timestampMs >= complete.assistantBeforeMs)
                ) {
                    continue;
                }
                locators.push(locator);
                unresolved.delete(index);
            }
        } else {
            firstGap ??= complete.reason;
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
            !authorizedProject(row) ||
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
        unresolved.size === 0 && !readSignal.aborted
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
        checkpoint: { rows: [...checkpoints.values()], projects: [...projects.values()] },
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
