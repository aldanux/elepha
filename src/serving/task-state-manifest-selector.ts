import { statSync } from 'node:fs';
import type Database from 'better-sqlite3-multiple-ciphers';
import { ClaudeCodeAdapter } from '../adapters/claude-code.js';
import {
    CURRENT_CHAT_EVIDENCE_MAX_ID_BYTES,
    CURRENT_CHAT_EVIDENCE_MAX_PATH_BYTES,
    TASK_STATE_HISTORICAL_MAX_TAIL_ROWS,
    TASK_STATE_MANIFEST_MAX_SOURCE_TURNS,
    TASK_STATE_MANIFEST_VERIFY_DEADLINE_MS,
} from '../config/constants.js';
import { canonicalizeExisting, samePath } from '../config/paths.js';
import { getSetting } from '../config/settings.js';
import { escapeShellSyntax } from '../security/sanitize.js';
import { ConsentStore } from '../storage/consent-store.js';
import { retentionRemovedSql } from '../storage/live-memory-retention-schema.js';
import {
    TASK_STATE_MANIFEST_PROJECTION_ENCODING,
    type TaskStateManifestRow,
    type TaskStateManifestSection,
    TaskStateManifestStore,
    validateTaskStateManifest,
} from '../storage/task-state-manifest-store.js';
import { SessionReader } from './session-reader.js';

interface CapturedTurn {
    memoryId: number;
    sessionId: number;
    segmentIndex: number;
    turnIndex: number;
    sourceCursor: string | null;
    sourceDigest: string | null;
    sourceGeneration: number;
    projectPath: string | null;
    sourcePath: string | null;
    kind: string | null;
}

export type ClaudePrecompactSelection = { state: 'available'; manifest: TaskStateManifestRow } | { state: 'unavailable'; reason: string };

export const CLAUDE_HISTORICAL_CHECKPOINT_VERSION = 1;

export type ClaudeHistoricalCheckpointSelection =
    | {
          state: 'available';
          checkpoint: {
              version: typeof CLAUDE_HISTORICAL_CHECKPOINT_VERSION;
              kind: 'historical_precompact';
              manifest: TaskStateManifestRow;
              asOfTurnIndex: number;
              latestIndexedTurn: { segmentIndex: number; turnIndex: number };
              indexedUnreviewedTail: {
                  observedTurnCountAtLeast: number;
                  truncated: boolean;
                  sourceBeyondIndex: 'unknown';
              };
          };
      }
    | { state: 'unavailable'; reason: string };

function physicalCheckout(value: string): string | undefined {
    try {
        return statSync(value).isDirectory() ? canonicalizeExisting(value) : undefined;
    } catch {
        return undefined;
    }
}

function cursorOffset(cursor: string | null): number | undefined {
    if (cursor === null || !/^(0|[1-9]\d*)\|\d+\|[a-f0-9]+$/.test(cursor)) {
        return undefined;
    }
    const offset = Number(cursor.slice(0, cursor.indexOf('|')));
    return Number.isSafeInteger(offset) ? offset : undefined;
}

function sameCaptured(left: CapturedTurn, right: CapturedTurn): boolean {
    return (
        left.memoryId === right.memoryId &&
        left.sessionId === right.sessionId &&
        left.segmentIndex === right.segmentIndex &&
        left.turnIndex === right.turnIndex &&
        left.sourceCursor === right.sourceCursor &&
        left.sourceDigest === right.sourceDigest &&
        left.sourceGeneration === right.sourceGeneration &&
        left.projectPath === right.projectPath &&
        left.sourcePath === right.sourcePath &&
        left.kind === right.kind
    );
}

function sourceQuote(
    manifest: TaskStateManifestRow,
    section: TaskStateManifestSection,
    itemIndex: number,
    quoteIndex: number,
): { role: 'user' | 'assistant'; quote: string } | undefined {
    const item = section === 'objective' ? (itemIndex === 0 ? manifest.report.objective : null) : manifest.report[section][itemIndex];
    return item?.sources[quoteIndex];
}

const CAPTURED_SELECT = `SELECT m.id AS memoryId, s.id AS sessionId, s.segment_index AS segmentIndex,
        m.turn_index AS turnIndex,
        CASE WHEN length(CAST(tsi.source_cursor AS BLOB)) <= ? THEN tsi.source_cursor END AS sourceCursor,
        tsi.source_digest AS sourceDigest, COALESCE(g.generation, 0) AS sourceGeneration,
        CASE WHEN length(CAST(p.path AS BLOB)) <= ? THEN p.path END AS projectPath,
        CASE WHEN length(CAST(s.source_path AS BLOB)) <= ? THEN s.source_path END AS sourcePath,
        s.kind
        FROM sessions s JOIN projects p ON p.id = s.project_id
        JOIN memories m ON m.session_id = s.id
        LEFT JOIN turn_search_index tsi ON tsi.memory_id = m.id
        LEFT JOIN source_generations g ON g.tool = s.tool AND g.native_id = s.native_id
        WHERE s.tool = 'claude-code' AND s.native_id = ?
          AND NOT EXISTS (SELECT 1 FROM purged_transcripts t WHERE t.tool = s.tool AND t.native_id = s.native_id) AND NOT ${retentionRemovedSql('s.tool', 's.native_id')}
          AND NOT EXISTS (SELECT 1 FROM incognito_transcripts t WHERE t.tool = s.tool AND t.native_id = s.native_id)`;

const capturedArgs = (nativeSessionId: string): [number, number, number, string] => [
    CURRENT_CHAT_EVIDENCE_MAX_PATH_BYTES,
    CURRENT_CHAT_EVIDENCE_MAX_PATH_BYTES,
    CURRENT_CHAT_EVIDENCE_MAX_PATH_BYTES,
    nativeSessionId,
];

// This selector reads only metadata and bounded source evidence. It does not
// deliver the report; callers must treat every unavailable result as abstention.
export async function selectFreshClaudePrecompactManifest(
    db: Database.Database,
    input: { nativeSessionId: string; cwd: string; transcriptPath: string; configPath?: string },
    reader: Pick<SessionReader, 'serveState' | 'indexedTurnEvidence'> = new SessionReader(db),
): Promise<ClaudePrecompactSelection> {
    const unavailable = (reason: string): ClaudePrecompactSelection => ({ state: 'unavailable', reason });
    if (!getSetting('memory-plus', {}, input.configPath).value) {
        return unavailable('memory_plus_disabled');
    }
    if (reader.serveState() === 'locked') {
        return unavailable('locked');
    }
    if (
        !input.nativeSessionId ||
        Buffer.byteLength(input.nativeSessionId) > CURRENT_CHAT_EVIDENCE_MAX_ID_BYTES ||
        Buffer.byteLength(input.cwd) > CURRENT_CHAT_EVIDENCE_MAX_PATH_BYTES ||
        Buffer.byteLength(input.transcriptPath) > CURRENT_CHAT_EVIDENCE_MAX_PATH_BYTES
    ) {
        return unavailable('invalid_request');
    }
    const adapter = new ClaudeCodeAdapter();
    if (!adapter.matches(input.transcriptPath) || adapter.nativeSessionId(input.transcriptPath) !== input.nativeSessionId) {
        return unavailable('transcript_identity_mismatch');
    }
    const consent = new ConsentStore(db);
    const checkout = physicalCheckout(input.cwd);
    if (checkout === undefined || consent.consentState(input.cwd) !== 'approved' || consent.isRefusedForCapture(input.cwd)) {
        return unavailable('checkout_not_consented');
    }
    const compact = await adapter.readLatestCompactSummary(input.transcriptPath);
    if (compact.status !== 'available') {
        return unavailable(compact.reason);
    }
    if (compact.boundaryByteStart >= compact.byteStart) {
        return unavailable('compact_boundary_unavailable');
    }

    const candidates = db
        .prepare(`${CAPTURED_SELECT}
        AND EXISTS (SELECT 1 FROM task_state_manifests tsm WHERE tsm.memory_id = m.id)
        ORDER BY s.segment_index DESC, m.turn_index DESC LIMIT ?`)
        .all(...capturedArgs(input.nativeSessionId), TASK_STATE_MANIFEST_MAX_SOURCE_TURNS + 1) as CapturedTurn[];
    if (candidates.length === 0) {
        return unavailable('manifest_missing');
    }
    for (const turn of candidates) {
        if (
            turn.kind !== 'main' ||
            turn.sourcePath !== input.transcriptPath ||
            turn.projectPath === null ||
            !samePath(physicalCheckout(turn.projectPath) ?? '', checkout) ||
            consent.consentState(turn.projectPath) !== 'approved' ||
            consent.isRefusedForCapture(turn.projectPath)
        ) {
            return unavailable('captured_scope_ambiguous');
        }
    }
    const beforeBoundary = candidates.filter((turn) => {
        const offset = cursorOffset(turn.sourceCursor);
        return offset !== undefined && offset <= compact.boundaryByteStart;
    });
    if (candidates.some((turn) => cursorOffset(turn.sourceCursor) === undefined)) {
        return unavailable('source_cursor_unavailable');
    }
    const manifests = new TaskStateManifestStore(db);
    let selected: { turn: CapturedTurn; manifest: TaskStateManifestRow } | undefined;
    for (const turn of beforeBoundary) {
        let manifest: TaskStateManifestRow | undefined;
        try {
            manifest = manifests.get(turn.memoryId);
            if (manifest !== undefined) {
                validateTaskStateManifest(manifest);
            }
        } catch {
            return unavailable('manifest_malformed');
        }
        if (manifest !== undefined) {
            selected = { turn, manifest };
            break;
        }
    }
    if (selected === undefined) {
        return unavailable(candidates.length > TASK_STATE_MANIFEST_MAX_SOURCE_TURNS ? 'manifest_scan_limit' : 'manifest_missing');
    }
    const { turn: reporting, manifest } = selected;
    const reportOffset = cursorOffset(reporting.sourceCursor);
    if (
        reportOffset === undefined ||
        reportOffset > compact.boundaryByteStart ||
        (compact.previousBoundaryByteStart !== null && reportOffset <= compact.previousBoundaryByteStart) ||
        (compact.previousBoundaryByteStart === null && compact.scanStart > 0 && reportOffset < compact.scanStart)
    ) {
        return unavailable('manifest_not_for_latest_compact');
    }
    const gap = await adapter.verifyEmptyPrecompactGap(input.transcriptPath, reportOffset, compact.boundaryByteStart);
    if (gap !== 'clear') {
        return unavailable(gap);
    }
    if (
        manifest.coverage.state !== 'verified' ||
        manifest.coverage.totalSourceCount === 0 ||
        manifest.coverage.resolvedSourceCount !== manifest.coverage.totalSourceCount ||
        manifest.sourceLocators.length !== manifest.coverage.totalSourceCount
    ) {
        return unavailable('manifest_incomplete');
    }
    // An existence check keeps postcompact history out of the result set.
    const interveningRead = db.prepare(`${CAPTURED_SELECT}
        AND (s.segment_index > ? OR (s.segment_index = ? AND m.turn_index > ?))
        AND (tsi.source_cursor IS NULL OR instr(tsi.source_cursor, '|') < 2 OR
             CAST(substr(tsi.source_cursor, 1, instr(tsi.source_cursor, '|') - 1) AS INTEGER) <= ?)
        ORDER BY s.segment_index ASC, m.turn_index ASC LIMIT 1`);
    const interveningArgs = [
        ...capturedArgs(input.nativeSessionId),
        reporting.segmentIndex,
        reporting.segmentIndex,
        reporting.turnIndex,
        compact.boundaryByteStart,
    ];
    const intervening = interveningRead.get(...interveningArgs) as CapturedTurn | undefined;
    if (intervening !== undefined) {
        return unavailable('intervening_captured_turn');
    }
    if (
        manifest.reportingSource.sessionId !== reporting.sessionId ||
        manifest.reportingSource.turnIndex !== reporting.turnIndex ||
        manifest.reportingSource.sourceGeneration !== reporting.sourceGeneration ||
        manifest.reportingSource.sourceDigest !== reporting.sourceDigest
    ) {
        return unavailable('reporting_source_changed');
    }
    const sourceIds = [...new Set(manifest.sourceLocators.map((locator) => locator.sourceMemoryId))];
    if (
        sourceIds.length === 0 ||
        sourceIds.length > TASK_STATE_MANIFEST_MAX_SOURCE_TURNS ||
        sourceIds.some((id) => !Number.isSafeInteger(id) || id < 1)
    ) {
        return unavailable('source_locator_limit');
    }
    const sourceRows = db
        .prepare(`${CAPTURED_SELECT} AND m.id IN (${sourceIds.map(() => '?').join(',')})`)
        .all(...capturedArgs(input.nativeSessionId), ...sourceIds) as CapturedTurn[];
    const byId = new Map(sourceRows.map((turn) => [turn.memoryId, turn]));
    for (const locator of manifest.sourceLocators) {
        const source = byId.get(locator.sourceMemoryId);
        const quote = sourceQuote(manifest, locator.section, locator.itemIndex, locator.quoteIndex);
        if (
            source === undefined ||
            quote === undefined ||
            quote.role !== locator.role ||
            source.sessionId !== locator.sourceSessionId ||
            source.turnIndex !== locator.sourceTurnIndex ||
            source.sourceGeneration !== locator.sourceGeneration ||
            source.sourceDigest !== locator.sourceDigest ||
            source.projectPath === null ||
            source.sourcePath === null ||
            source.kind !== 'main' ||
            source.sourcePath !== input.transcriptPath ||
            !samePath(physicalCheckout(source.projectPath) ?? '', checkout) ||
            consent.consentState(source.projectPath) !== 'approved' ||
            consent.isRefusedForCapture(source.projectPath) ||
            locator.projectionEncoding !== TASK_STATE_MANIFEST_PROJECTION_ENCODING ||
            (source.memoryId === reporting.memoryId && locator.role === 'assistant')
        ) {
            return unavailable('source_locator_changed');
        }
        const evidence = await reader.indexedTurnEvidence(
            {
                id: source.sessionId,
                tool: 'claude-code',
                native_id: input.nativeSessionId,
                source_path: source.sourcePath,
                expectedProjectPath: source.projectPath,
            },
            source.turnIndex,
        );
        if (evidence.state !== 'available') {
            return unavailable(`source_evidence_${evidence.reason}`);
        }
        if (evidence.source !== locator.evidenceSource) {
            return unavailable('source_evidence_changed');
        }
        const roleText = locator.role === 'user' ? evidence.projection.userPrompt : evidence.projection.assistantResponse;
        if (escapeShellSyntax(roleText).slice(locator.start, locator.end) !== quote.quote) {
            return unavailable('source_quote_changed');
        }
    }
    if (
        !getSetting('memory-plus', {}, input.configPath).value ||
        reader.serveState() === 'locked' ||
        consent.consentState(input.cwd) !== 'approved' ||
        consent.isRefusedForCapture(input.cwd) ||
        !samePath(physicalCheckout(input.cwd) ?? '', checkout)
    ) {
        return unavailable('authorization_changed');
    }
    const latest = await adapter.readLatestCompactSummary(input.transcriptPath);
    if (latest.status !== 'available' || latest.boundaryByteStart !== compact.boundaryByteStart || latest.byteEnd !== compact.byteEnd) {
        return unavailable('compact_source_changed');
    }
    const expected = new Map([reporting, ...sourceRows].map((turn) => [turn.memoryId, turn]));
    const currentIds = [...expected.keys()];
    const currentRows = db
        .prepare(`${CAPTURED_SELECT} AND m.id IN (${currentIds.map(() => '?').join(',')})`)
        .all(...capturedArgs(input.nativeSessionId), ...currentIds) as CapturedTurn[];
    let currentManifest: TaskStateManifestRow | undefined;
    try {
        currentManifest = manifests.get(reporting.memoryId);
    } catch {
        return unavailable('source_state_changed');
    }
    if (
        currentRows.length !== expected.size ||
        currentRows.some((turn) => {
            const original = expected.get(turn.memoryId);
            return (
                original === undefined ||
                !sameCaptured(turn, original) ||
                turn.projectPath === null ||
                consent.consentState(turn.projectPath) !== 'approved' ||
                consent.isRefusedForCapture(turn.projectPath) ||
                !samePath(physicalCheckout(turn.projectPath) ?? '', checkout)
            );
        }) ||
        interveningRead.get(...interveningArgs) !== undefined ||
        JSON.stringify(currentManifest) !== JSON.stringify(manifest) ||
        !getSetting('memory-plus', {}, input.configPath).value ||
        consent.consentState(input.cwd) !== 'approved' ||
        consent.isRefusedForCapture(input.cwd) ||
        !samePath(physicalCheckout(input.cwd) ?? '', checkout)
    ) {
        return unavailable('source_state_changed');
    }
    return { state: 'available', manifest };
}

// A historical checkpoint says what the verified report recorded at its turn.
// Later indexed turns are deliberately left unreviewed, and the transcript may
// contain newer turns that ingestion has not indexed yet.
async function readHistoricalClaudePrecompactCheckpoint(
    db: Database.Database,
    input: { nativeSessionId: string; cwd: string; transcriptPath: string; configPath?: string },
    reader: Pick<SessionReader, 'serveState' | 'indexedTurnEvidence'> = new SessionReader(db),
): Promise<ClaudeHistoricalCheckpointSelection> {
    const unavailable = (reason: string): ClaudeHistoricalCheckpointSelection => ({ state: 'unavailable', reason });
    if (!getSetting('memory-plus', {}, input.configPath).value) {
        return unavailable('memory_plus_disabled');
    }
    if (reader.serveState() === 'locked') {
        return unavailable('locked');
    }
    if (
        !input.nativeSessionId ||
        Buffer.byteLength(input.nativeSessionId) > CURRENT_CHAT_EVIDENCE_MAX_ID_BYTES ||
        Buffer.byteLength(input.cwd) > CURRENT_CHAT_EVIDENCE_MAX_PATH_BYTES ||
        Buffer.byteLength(input.transcriptPath) > CURRENT_CHAT_EVIDENCE_MAX_PATH_BYTES
    ) {
        return unavailable('invalid_request');
    }
    const adapter = new ClaudeCodeAdapter();
    if (!adapter.matches(input.transcriptPath) || adapter.nativeSessionId(input.transcriptPath) !== input.nativeSessionId) {
        return unavailable('transcript_identity_mismatch');
    }
    const consent = new ConsentStore(db);
    const checkout = physicalCheckout(input.cwd);
    if (checkout === undefined || consent.consentState(input.cwd) !== 'approved' || consent.isRefusedForCapture(input.cwd)) {
        return unavailable('checkout_not_consented');
    }
    const authorized = (turn: CapturedTurn): boolean =>
        turn.kind === 'main' &&
        turn.sourcePath === input.transcriptPath &&
        turn.projectPath !== null &&
        samePath(physicalCheckout(turn.projectPath) ?? '', checkout) &&
        consent.consentState(turn.projectPath) === 'approved' &&
        !consent.isRefusedForCapture(turn.projectPath);
    const stillAllowed = (): boolean =>
        getSetting('memory-plus', {}, input.configPath).value &&
        reader.serveState() !== 'locked' &&
        consent.consentState(input.cwd) === 'approved' &&
        !consent.isRefusedForCapture(input.cwd) &&
        samePath(physicalCheckout(input.cwd) ?? '', checkout);
    const args = capturedArgs(input.nativeSessionId);
    const latestManifestTurn = db
        .prepare(`${CAPTURED_SELECT}
            AND EXISTS (SELECT 1 FROM task_state_manifests tsm WHERE tsm.memory_id = m.id)
            ORDER BY s.segment_index DESC, m.turn_index DESC LIMIT 1`)
        .get(...args) as CapturedTurn | undefined;
    if (latestManifestTurn === undefined) {
        return unavailable('manifest_missing');
    }
    if (!authorized(latestManifestTurn)) {
        return unavailable('captured_scope_ambiguous');
    }
    const reportingProjectPath = latestManifestTurn.projectPath;
    if (reportingProjectPath === null) {
        return unavailable('captured_scope_ambiguous');
    }
    const manifests = new TaskStateManifestStore(db);
    let manifest: TaskStateManifestRow | undefined;
    try {
        manifest = manifests.get(latestManifestTurn.memoryId);
        if (manifest !== undefined) {
            validateTaskStateManifest(manifest);
        }
    } catch {
        return unavailable('manifest_malformed');
    }
    if (
        manifest === undefined ||
        manifest.coverage.state !== 'verified' ||
        manifest.coverage.totalSourceCount === 0 ||
        manifest.coverage.resolvedSourceCount !== manifest.coverage.totalSourceCount ||
        manifest.sourceLocators.length !== manifest.coverage.totalSourceCount
    ) {
        return unavailable('manifest_incomplete');
    }
    if (
        manifest.reportingSource.sessionId !== latestManifestTurn.sessionId ||
        manifest.reportingSource.turnIndex !== latestManifestTurn.turnIndex ||
        manifest.reportingSource.sourceGeneration !== latestManifestTurn.sourceGeneration ||
        manifest.reportingSource.sourceDigest !== latestManifestTurn.sourceDigest
    ) {
        return unavailable('reporting_source_changed');
    }
    const sourceIds = [...new Set(manifest.sourceLocators.map((locator) => locator.sourceMemoryId))];
    if (
        sourceIds.length === 0 ||
        sourceIds.length > TASK_STATE_MANIFEST_MAX_SOURCE_TURNS ||
        sourceIds.some((id) => !Number.isSafeInteger(id) || id < 1)
    ) {
        return unavailable('source_locator_limit');
    }
    const sourceRows = db
        .prepare(`${CAPTURED_SELECT} AND m.id IN (${sourceIds.map(() => '?').join(',')})`)
        .all(...args, ...sourceIds) as CapturedTurn[];
    const byId = new Map(sourceRows.map((turn) => [turn.memoryId, turn]));
    const deadline = AbortSignal.timeout(TASK_STATE_MANIFEST_VERIFY_DEADLINE_MS);
    const reportingEvidence = await reader.indexedTurnEvidence(
        {
            id: latestManifestTurn.sessionId,
            tool: 'claude-code',
            native_id: input.nativeSessionId,
            source_path: input.transcriptPath,
            expectedProjectPath: reportingProjectPath,
        },
        latestManifestTurn.turnIndex,
        deadline,
    );
    if (reportingEvidence.state !== 'available') {
        return unavailable(`reporting_evidence_${reportingEvidence.reason}`);
    }
    for (const locator of manifest.sourceLocators) {
        if (deadline.aborted) {
            return unavailable('deadline');
        }
        const source = byId.get(locator.sourceMemoryId);
        const quote = sourceQuote(manifest, locator.section, locator.itemIndex, locator.quoteIndex);
        if (
            source === undefined ||
            quote === undefined ||
            quote.role !== locator.role ||
            source.sessionId !== locator.sourceSessionId ||
            source.turnIndex !== locator.sourceTurnIndex ||
            source.sourceGeneration !== locator.sourceGeneration ||
            source.sourceDigest !== locator.sourceDigest ||
            !authorized(source) ||
            source.projectPath === null ||
            locator.projectionEncoding !== TASK_STATE_MANIFEST_PROJECTION_ENCODING ||
            (source.memoryId === latestManifestTurn.memoryId && locator.role === 'assistant')
        ) {
            return unavailable('source_locator_changed');
        }
        const evidence = await reader.indexedTurnEvidence(
            {
                id: source.sessionId,
                tool: 'claude-code',
                native_id: input.nativeSessionId,
                source_path: input.transcriptPath,
                expectedProjectPath: source.projectPath,
            },
            source.turnIndex,
            deadline,
        );
        if (evidence.state !== 'available') {
            return unavailable(`source_evidence_${evidence.reason}`);
        }
        if (evidence.source !== locator.evidenceSource) {
            return unavailable('source_evidence_changed');
        }
        const roleText = locator.role === 'user' ? evidence.projection.userPrompt : evidence.projection.assistantResponse;
        if (escapeShellSyntax(roleText).slice(locator.start, locator.end) !== quote.quote) {
            return unavailable('source_quote_changed');
        }
    }
    if (deadline.aborted || !stillAllowed()) {
        return unavailable(deadline.aborted ? 'deadline' : 'authorization_changed');
    }
    const laterThanReport = `AND (s.segment_index > ? OR (s.segment_index = ? AND m.turn_index > ?))`;
    const tailArgs = [...args, latestManifestTurn.segmentIndex, latestManifestTurn.segmentIndex, latestManifestTurn.turnIndex];
    const tailRead = db.prepare(`${CAPTURED_SELECT} ${laterThanReport}
            ORDER BY s.segment_index DESC, m.turn_index DESC LIMIT ?`);
    const tail = tailRead.all(...tailArgs, TASK_STATE_HISTORICAL_MAX_TAIL_ROWS + 1) as CapturedTurn[];
    const latestIndexed = tail[0] ?? latestManifestTurn;
    if (!authorized(latestIndexed) || tail.some((turn) => !authorized(turn))) {
        return unavailable('captured_scope_ambiguous');
    }
    const latestProjectPath = latestIndexed.projectPath;
    if (latestProjectPath === null) {
        return unavailable('captured_scope_ambiguous');
    }
    if (tail.length > 0) {
        const evidence = await reader.indexedTurnEvidence(
            {
                id: latestIndexed.sessionId,
                tool: 'claude-code',
                native_id: input.nativeSessionId,
                source_path: input.transcriptPath,
                expectedProjectPath: latestProjectPath,
            },
            latestIndexed.turnIndex,
            deadline,
        );
        if (evidence.state !== 'available') {
            return unavailable(`latest_indexed_evidence_${evidence.reason}`);
        }
    }
    const expected = new Map([latestManifestTurn, ...sourceRows, latestIndexed].map((turn) => [turn.memoryId, turn]));
    const currentIds = [...expected.keys()];
    const currentRows = db
        .prepare(`${CAPTURED_SELECT} AND m.id IN (${currentIds.map(() => '?').join(',')})`)
        .all(...args, ...currentIds) as CapturedTurn[];
    let currentManifest: TaskStateManifestRow | undefined;
    try {
        currentManifest = manifests.get(latestManifestTurn.memoryId);
    } catch {
        return unavailable('source_state_changed');
    }
    const currentLatest = db.prepare(`${CAPTURED_SELECT} ORDER BY s.segment_index DESC, m.turn_index DESC LIMIT 1`).get(...args) as
        | CapturedTurn
        | undefined;
    const currentTail = tailRead.all(...tailArgs, TASK_STATE_HISTORICAL_MAX_TAIL_ROWS + 1) as CapturedTurn[];
    if (
        deadline.aborted ||
        !stillAllowed() ||
        currentRows.length !== expected.size ||
        currentRows.some((turn) => {
            const original = expected.get(turn.memoryId);
            return original === undefined || !sameCaptured(turn, original) || !authorized(turn);
        }) ||
        currentTail.length !== tail.length ||
        currentTail.some((turn, index) => {
            const original = tail[index];
            return original === undefined || !sameCaptured(turn, original);
        }) ||
        currentLatest === undefined ||
        !sameCaptured(currentLatest, latestIndexed) ||
        JSON.stringify(currentManifest) !== JSON.stringify(manifest)
    ) {
        return unavailable(deadline.aborted ? 'deadline' : 'source_state_changed');
    }
    return {
        state: 'available',
        checkpoint: {
            version: CLAUDE_HISTORICAL_CHECKPOINT_VERSION,
            kind: 'historical_precompact',
            manifest,
            asOfTurnIndex: latestManifestTurn.turnIndex,
            latestIndexedTurn: { segmentIndex: latestIndexed.segmentIndex, turnIndex: latestIndexed.turnIndex },
            indexedUnreviewedTail: {
                observedTurnCountAtLeast: Math.min(tail.length, TASK_STATE_HISTORICAL_MAX_TAIL_ROWS),
                truncated: tail.length > TASK_STATE_HISTORICAL_MAX_TAIL_ROWS,
                sourceBeyondIndex: 'unknown',
            },
        },
    };
}

export async function selectHistoricalClaudePrecompactCheckpoint(
    db: Database.Database,
    input: { nativeSessionId: string; cwd: string; transcriptPath: string; configPath?: string },
    reader: Pick<SessionReader, 'serveState' | 'indexedTurnEvidence'> = new SessionReader(db),
): Promise<ClaudeHistoricalCheckpointSelection> {
    try {
        return await readHistoricalClaudePrecompactCheckpoint(db, input, reader);
    } catch {
        return { state: 'unavailable', reason: 'checkpoint_read_error' };
    }
}
