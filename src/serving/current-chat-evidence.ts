import { statSync } from 'node:fs';
import type Database from 'better-sqlite3-multiple-ciphers';
import {
    CURRENT_CHAT_EVIDENCE_DEADLINE_MS,
    CURRENT_CHAT_EVIDENCE_MAX_CANDIDATES,
    CURRENT_CHAT_EVIDENCE_MAX_CHARS,
    CURRENT_CHAT_EVIDENCE_MAX_ID_BYTES,
    CURRENT_CHAT_EVIDENCE_MAX_METADATA_PAGES,
    CURRENT_CHAT_EVIDENCE_MAX_PATH_BYTES,
    CURRENT_CHAT_EVIDENCE_MAX_QUERY_CHARS,
    CURRENT_CHAT_EVIDENCE_MAX_SEGMENT_READS,
    CURRENT_CHAT_EVIDENCE_MAX_TURNS,
    CURRENT_CHAT_EVIDENCE_SEGMENT_PAGE,
} from '../config/constants.js';
import { canonicalizeExisting, samePath } from '../config/paths.js';
import { escapeShellSyntax } from '../security/sanitize.js';
import { gitRevParseShowToplevel } from '../security/subprocess-allowlist.js';
import { ConsentStore } from '../storage/consent-store.js';
import { ProjectResolver } from '../storage/project-resolver.js';
import { type CurrentChatSegment, readCurrentChatSegmentById, readCurrentChatSegmentPage } from '../storage/session-read-model.js';
import { SUPPORTED_TOOLS, type ToolName } from '../types/index.js';
import { tokenizeRecallQuery } from './lexical-recall.js';
import { SessionReader } from './session-reader.js';

export interface CurrentChatEvidenceInput {
    tool: ToolName;
    nativeSessionId: string;
    cwd: string;
    mode: 'continuation' | 'query';
    query?: string;
}

export interface CurrentChatEvidenceTurn {
    segmentIndex: number;
    turnIndex: number;
    userPrompt: string;
    assistantResponse: string;
}

export type CurrentChatEvidenceResult =
    | {
          state: 'available';
          source: { tool: ToolName; nativeSessionId: string };
          evidence: CurrentChatEvidenceTurn[];
          omittedTurnCount: number;
          partialCoverage: boolean;
          partialCoverageReason?: string;
      }
    | { state: 'empty' | 'unavailable'; reason: string };

function physicalDirectory(value: string): string | undefined {
    try {
        if (statSync(value).isDirectory()) {
            return canonicalizeExisting(value);
        }
    } catch {
        // A moved or removed checkout cannot establish the current physical scope.
    }
    return undefined;
}

function checkoutAnchor(value: string): string {
    return canonicalizeExisting(gitRevParseShowToplevel(value) ?? value);
}

function* currentChatSegments(
    db: Database.Database,
    tool: ToolName,
    nativeId: string,
    coverage: { truncated: boolean },
): Iterable<CurrentChatSegment> {
    let before: number | null = null;
    for (let pageIndex = 0; pageIndex < CURRENT_CHAT_EVIDENCE_MAX_METADATA_PAGES; pageIndex++) {
        const page = readCurrentChatSegmentPage(
            db,
            tool,
            nativeId,
            CURRENT_CHAT_EVIDENCE_MAX_PATH_BYTES,
            before,
            CURRENT_CHAT_EVIDENCE_SEGMENT_PAGE,
        );
        if (page.length === 0) {
            return;
        }
        yield* page;
        before = page.at(-1)?.segmentIndex ?? null;
        if (page.length < CURRENT_CHAT_EVIDENCE_SEGMENT_PAGE) {
            return;
        }
    }
    coverage.truncated = readCurrentChatSegmentPage(db, tool, nativeId, CURRENT_CHAT_EVIDENCE_MAX_PATH_BYTES, before, 1).length > 0;
}

function eligibleCheckout(
    consent: ConsentStore,
    projectPath: string | null,
    projectId: number,
    currentAnchor: string,
    allowedProjectIds: ReadonlySet<number>,
    anchors?: Map<string, string>,
): boolean {
    if (
        projectPath === null ||
        consent.consentState(projectPath) !== 'approved' ||
        consent.isRefusedForCapture(projectPath) ||
        !allowedProjectIds.has(projectId)
    ) {
        return false;
    }
    const physical = physicalDirectory(projectPath);
    if (physical === undefined) {
        return false;
    }
    let anchor = anchors?.get(physical);
    if (anchor === undefined) {
        anchor = checkoutAnchor(physical);
        anchors?.set(physical, anchor);
    }
    return samePath(anchor, currentAnchor);
}

// A turn is evidence only with both native-chat provenance and its paired
// user/assistant text. Session rollups cannot establish that pairing.
export async function currentChatEvidence(
    db: Database.Database,
    input: CurrentChatEvidenceInput,
    reader: SessionReader = new SessionReader(db),
    signal?: AbortSignal,
): Promise<CurrentChatEvidenceResult> {
    const deadlineAt = Date.now() + CURRENT_CHAT_EVIDENCE_DEADLINE_MS;
    if (
        !SUPPORTED_TOOLS.includes(input.tool) ||
        !input.nativeSessionId.trim() ||
        Buffer.byteLength(input.nativeSessionId, 'utf8') > CURRENT_CHAT_EVIDENCE_MAX_ID_BYTES ||
        Buffer.byteLength(input.cwd, 'utf8') > CURRENT_CHAT_EVIDENCE_MAX_PATH_BYTES ||
        (input.mode !== 'continuation' && input.mode !== 'query')
    ) {
        return { state: 'unavailable', reason: 'invalid_current_chat_request' };
    }
    if (reader.serveState() === 'locked') {
        return { state: 'unavailable', reason: 'locked' };
    }
    const consent = new ConsentStore(db);
    const physicalCwd = physicalDirectory(input.cwd);
    if (physicalCwd === undefined || consent.consentState(input.cwd) !== 'approved' || consent.isRefusedForCapture(input.cwd)) {
        return { state: 'unavailable', reason: 'checkout_not_consented' };
    }
    const currentAnchor = checkoutAnchor(physicalCwd);
    const allowedProjectIds = new Set(new ProjectResolver(db).listConsentedStored(consent).flatMap((project) => project.projectIds));
    const anchors = new Map<string, string>();
    const query = input.mode === 'query' ? input.query?.trim() : undefined;
    if (input.mode === 'query' && (!query || query.length > CURRENT_CHAT_EVIDENCE_MAX_QUERY_CHARS)) {
        return { state: 'unavailable', reason: 'invalid_evidence_query' };
    }
    const terms = query === undefined ? [] : (tokenizeRecallQuery(query)?.components ?? []);
    if (input.mode === 'query' && terms.length === 0) {
        return { state: 'unavailable', reason: 'invalid_evidence_query' };
    }
    const deadline = AbortSignal.timeout(Math.max(1, deadlineAt - Date.now()));
    const readSignal = signal === undefined ? deadline : AbortSignal.any([signal, deadline]);
    const candidates: Array<CurrentChatEvidenceTurn & { sessionId: number; sourcePath: string; score: number }> = [];
    let omittedTurnCount = 0;
    let partialCoverage = false;
    let unavailableReason: string | undefined;
    let scopedSegments = 0;
    let segmentReads = 0;
    let sawSegment = false;
    const metadataCoverage = { truncated: false };
    for (const segment of currentChatSegments(db, input.tool, input.nativeSessionId, metadataCoverage)) {
        sawSegment = true;
        if (readSignal.aborted || Date.now() >= deadlineAt) {
            partialCoverage = true;
            unavailableReason ??= 'deadline';
            break;
        }
        if (segment.projectPath === null) {
            partialCoverage = true;
            unavailableReason ??= 'current_chat_project_path_too_long';
            continue;
        }
        if (!eligibleCheckout(consent, segment.projectPath, segment.projectId, currentAnchor, allowedProjectIds, anchors)) {
            continue;
        }
        scopedSegments++;
        if (segment.turnCount === 0) {
            partialCoverage = true;
            unavailableReason ??= 'current_chat_turn_not_ingested';
            continue;
        }
        if (segment.source_path === null) {
            partialCoverage = true;
            unavailableReason ??= 'evidence_source_path_too_long';
            continue;
        }
        if (segmentReads >= CURRENT_CHAT_EVIDENCE_MAX_SEGMENT_READS) {
            partialCoverage = true;
            unavailableReason ??= 'older_segments_not_read';
            break;
        }
        segmentReads++;
        const window = await reader.indexedEvidenceWindow(
            { ...segment, source_path: segment.source_path, expectedProjectPath: segment.projectPath ?? undefined },
            undefined,
            readSignal,
        );
        if (window.projections === undefined || window.turnIndexes === undefined) {
            partialCoverage = true;
            unavailableReason ??= window.reason ?? 'evidence_source_unavailable';
            continue;
        }
        omittedTurnCount += window.omitted;
        partialCoverage ||= window.omitted > 0;
        for (let index = window.projections.length - 1; index >= 0; index--) {
            const projection = window.projections[index];
            const turnIndex = window.turnIndexes[index];
            if (projection === undefined || turnIndex === undefined || !projection.userPrompt.trim()) {
                continue;
            }
            const combined = `${projection.userPrompt}\n${projection.assistantResponse}`.normalize('NFKC').toLowerCase();
            const score = terms.filter((term) => combined.includes(term.toLowerCase())).length;
            if (input.mode === 'query' && score === 0) {
                continue;
            }
            candidates.push({
                sessionId: segment.id,
                sourcePath: segment.source_path,
                segmentIndex: segment.segmentIndex,
                turnIndex,
                userPrompt: escapeShellSyntax(projection.userPrompt),
                assistantResponse: escapeShellSyntax(projection.assistantResponse),
                score,
            });
            candidates.sort((a, b) => b.score - a.score || b.segmentIndex - a.segmentIndex || b.turnIndex - a.turnIndex);
            if (candidates.length > CURRENT_CHAT_EVIDENCE_MAX_CANDIDATES) {
                candidates.pop();
                partialCoverage = true;
                omittedTurnCount++;
            }
        }
    }
    if (!sawSegment) {
        return { state: 'unavailable', reason: 'current_chat_not_ingested' };
    }
    if (metadataCoverage.truncated) {
        partialCoverage = true;
        unavailableReason ??= 'older_segments_not_scanned';
    }
    if (scopedSegments === 0) {
        return { state: 'unavailable', reason: unavailableReason ?? 'current_chat_checkout_mismatch' };
    }
    if (reader.serveState() === 'locked') {
        return { state: 'unavailable', reason: 'locked' };
    }
    if (readSignal.aborted || Date.now() >= deadlineAt) {
        return { state: 'unavailable', reason: 'deadline' };
    }
    candidates.sort((a, b) => b.score - a.score || b.segmentIndex - a.segmentIndex || b.turnIndex - a.turnIndex);
    const currentlyAllowedProjectIds = new Set(
        new ProjectResolver(db).listConsentedStored(consent).flatMap((project) => project.projectIds),
    );
    const evidence: CurrentChatEvidenceTurn[] = [];
    let chars = 0;
    for (const candidate of candidates) {
        if (evidence.length >= CURRENT_CHAT_EVIDENCE_MAX_TURNS) {
            break;
        }
        const current = readCurrentChatSegmentById(
            db,
            input.tool,
            input.nativeSessionId,
            CURRENT_CHAT_EVIDENCE_MAX_PATH_BYTES,
            candidate.sessionId,
        );
        if (
            readSignal.aborted ||
            current === undefined ||
            current.source_path !== candidate.sourcePath ||
            consent.consentState(input.cwd) !== 'approved' ||
            consent.isRefusedForCapture(input.cwd) ||
            !samePath(checkoutAnchor(physicalDirectory(input.cwd) ?? input.cwd), currentAnchor) ||
            !eligibleCheckout(consent, current.projectPath, current.projectId, currentAnchor, currentlyAllowedProjectIds)
        ) {
            return { state: 'unavailable', reason: 'current_chat_authorization_changed' };
        }
        const addition = candidate.userPrompt.length + candidate.assistantResponse.length;
        if (addition > CURRENT_CHAT_EVIDENCE_MAX_CHARS) {
            return { state: 'unavailable', reason: 'evidence_turn_exceeds_budget' };
        }
        if (chars + addition > CURRENT_CHAT_EVIDENCE_MAX_CHARS) {
            partialCoverage = true;
            break;
        }
        chars += addition;
        evidence.push({
            segmentIndex: candidate.segmentIndex,
            turnIndex: candidate.turnIndex,
            userPrompt: candidate.userPrompt,
            assistantResponse: candidate.assistantResponse,
        });
    }
    if (evidence.length === 0) {
        if (input.mode === 'query' && partialCoverage) {
            return { state: 'unavailable', reason: unavailableReason ?? 'older_turns_not_searched' };
        }
        return unavailableReason === undefined
            ? { state: 'empty', reason: candidates.length > 0 ? 'evidence_exceeds_budget' : 'no_relevant_current_chat_turn' }
            : { state: 'unavailable', reason: unavailableReason };
    }
    omittedTurnCount += candidates.length - evidence.length;
    partialCoverage ||= omittedTurnCount > 0;
    return {
        state: 'available',
        source: { tool: input.tool, nativeSessionId: escapeShellSyntax(input.nativeSessionId) },
        evidence,
        omittedTurnCount,
        partialCoverage,
        ...(partialCoverage ? { partialCoverageReason: unavailableReason ?? 'older_turns_omitted' } : {}),
    };
}
