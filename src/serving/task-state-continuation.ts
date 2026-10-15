import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3-multiple-ciphers';
import { TranscriptReadBudgetError } from '../adapters/base.js';
import { sameTaskStateReportInput } from '../adapters/task-state-report.js';
import { CODEX_TASK_SOURCE_KIND } from '../config/codex.js';
import { CURRENT_CHAT_EVIDENCE_MAX_CHARS, CURRENT_CHAT_EVIDENCE_MAX_TURNS } from '../config/constants.js';
import { canonicalizeExisting, samePath } from '../config/paths.js';
import { filterTurn } from '../rendering/filtered-turn.js';
import { omissionMarker, renderFilteredTurn } from '../rendering/raw-turn-renderer.js';
import { escapeShellSyntax } from '../security/sanitize.js';
import { InjectionStore } from '../storage/injection-store.js';
import { readTaskSourcePosition } from '../storage/session-read-model.js';
import { decodeResumeContext } from '../storage/source-resume-context.js';
import { sourceTurnDigest, sourceTurnDigests } from '../storage/source-turn-digest.js';
import type { TaskStateManifestRow } from '../storage/task-state-manifest-store.js';
import type { ParsedTurn } from '../types/index.js';
import {
    dataBlockClose,
    dataBlockOpen,
    servedContextInstructions,
    TASK_STATE_CHECKPOINT_INTRODUCTION,
    TASK_STATE_CURRENT_INTRODUCTION,
} from './instructions.js';
import { authenticateTaskStateChat, type TaskStateChatInput } from './task-state-chat.js';
import { selectFreshClaudePrecompactManifest, selectTaskStateCheckpoint } from './task-state-manifest-selector.js';

// Source authentication and task freshness share one allowance and deadline.
// The adapters interpret native records, including opaque compact boundaries.
async function nativeEvidence(
    db: Database.Database,
    chat: NonNullable<Awaited<ReturnType<typeof authenticateTaskStateChat>>>,
    input: TaskStateChatInput,
    manifest: TaskStateManifestRow,
) {
    const budget = chat.readBudget;
    const injections = new InjectionStore(db);
    const sources = new Map([
        [manifest.memoryId, { turnIndex: manifest.reportingSource.turnIndex, digest: manifest.reportingSource.sourceDigest }],
        ...manifest.sourceLocators.map(
            (locator) => [locator.sourceMemoryId, { turnIndex: locator.sourceTurnIndex, digest: locator.sourceDigest }] as const,
        ),
    ]);
    const reporting = readTaskSourcePosition(db, input.tool, input.nativeSessionId, manifest.memoryId);
    if (!reporting) {
        return { reason: 'source_cursor_unavailable' };
    }
    const scopeMatches = (turn: { tool: string; sessionId: string; projectPath: string }): boolean =>
        turn.tool === input.tool &&
        turn.sessionId === input.nativeSessionId &&
        samePath(canonicalizeExisting(turn.projectPath), canonicalizeExisting(input.cwd));
    for (const [memoryId, expected] of sources) {
        const position = readTaskSourcePosition(db, input.tool, input.nativeSessionId, memoryId);
        if (!position || (expected.turnIndex > 0 && !position.beforeCursor)) {
            return { reason: 'source_cursor_unavailable' };
        }
        const end = chat.adapter.cursorPosition?.(position.cursor).byteOffset;
        if (end === undefined) {
            return { reason: 'source_cursor_unavailable' };
        }
        let matched = false;
        let invalid = false;
        for await (const turn of chat.adapter.parseTurns(chat.binding.sourcePath, position.beforeCursor ?? undefined, {
            handle: chat.opened.handle,
            readBudget: budget,
            signal: input.signal,
            endByteOffset: end,
            includeClosingBoundary: true,
            resumeContext: decodeResumeContext(position.beforeContext),
            closeTrailingOnIdle: true,
            skipSessionTitle: true,
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
            if (turn.turnIndex === expected.turnIndex) {
                matched =
                    scopeMatches(turn) &&
                    chat.adapter.cursorPosition?.(turn.cursor).byteOffset === end &&
                    sourceTurnDigests(turn).includes(expected.digest) &&
                    (memoryId !== manifest.memoryId ||
                        (turn.taskStateReport !== undefined && sameTaskStateReportInput(turn.taskStateReport, manifest.report)));
            }
        }
        if (!matched || invalid || !chat.current()) {
            return { reason: 'source_evidence_changed' };
        }
    }
    const turns: string[] = [];
    const evidenceDigest = createHash('sha256');
    let omitted = 0;
    let meaningful = false;
    let boundary: number | undefined;
    let gap: string | undefined;
    let invalid = false;
    let chars = 0;
    let pending: ParsedTurn | undefined;
    let excludedProtectionIncomplete = false;
    const observeExcludedTurn = (turn: ParsedTurn): boolean => {
        if (turn.droppedReason === 'elepha-mcp' && !injections.rememberElephaMcpReceipts(turn)) {
            return false;
        }
        // Only a genuinely empty observation proves absence. Excluded content
        // cannot establish freshness; keep its structural identity, never its text.
        if (
            turn.droppedReason !== 'empty' ||
            turn.userMessage.trim() ||
            turn.assistantText.trim() ||
            turn.toolCalls.length > 0 ||
            turn.taskStateReport ||
            turn.taskStateReportFailure
        ) {
            gap ??= 'excluded_turn';
            evidenceDigest.update(JSON.stringify([turn.turnIndex, turn.cursor, turn.droppedReason]));
        }
        return true;
    };
    try {
        for await (const turn of chat.adapter.parseTurns(chat.binding.sourcePath, reporting.cursor, {
            handle: chat.opened.handle,
            readBudget: budget,
            signal: input.signal,
            resumeContext: decodeResumeContext(reporting.context),
            closeTrailingOnIdle: true,
            skipSessionTitle: true,
            onCompactionBoundary: (offset) => {
                boundary = offset;
            },
            onDesync: () => {
                invalid = true;
            },
            onMalformedRecords: () => {
                invalid = true;
            },
            onUnrecognizedRecords: () => {
                invalid = true;
            },
            onOpenTail: () => {
                gap = 'open_turn';
                meaningful = true;
            },
            onPendingTurn: (turn) => {
                if (!scopeMatches(turn)) {
                    invalid = true;
                } else if (turn.droppedReason !== undefined) {
                    excludedProtectionIncomplete = !observeExcludedTurn(turn);
                } else {
                    pending = turn;
                }
            },
        })) {
            if (input.signal.aborted) {
                return { reason: 'deadline' };
            }
            if (!scopeMatches(turn)) {
                return { reason: 'transcript_identity_mismatch' };
            }
            if (turn.droppedReason !== undefined) {
                if (!observeExcludedTurn(turn)) {
                    return { reason: 'self_ingestion_protection_incomplete' };
                }
                continue;
            }
            const quoteBack = injections.quoteBackStatus(turn);
            if (quoteBack === 'incomplete') {
                return { reason: 'self_ingestion_protection_incomplete' };
            }
            // A newer report awaiting publication is meaningful even without prose.
            if (
                turn.taskStateReport ||
                turn.taskStateReportFailure ||
                turn.userMessage.trim() ||
                turn.assistantText.trim() ||
                turn.toolCalls.length > 0
            ) {
                meaningful = true;
                evidenceDigest.update(sourceTurnDigest(turn));
            }
            if (quoteBack === 'match') {
                continue;
            }
            const rendered = renderFilteredTurn(filterTurn(turn), turn.turnIndex);
            if (rendered !== null) {
                turns.push(rendered);
                chars += rendered.length;
                while (turns.length > CURRENT_CHAT_EVIDENCE_MAX_TURNS || chars > CURRENT_CHAT_EVIDENCE_MAX_CHARS) {
                    chars -= turns.shift()?.length ?? 0;
                    omitted++;
                }
            }
        }
        if (excludedProtectionIncomplete) {
            return { reason: 'self_ingestion_protection_incomplete' };
        }
        if (pending !== undefined && pending.droppedReason === undefined) {
            if (!scopeMatches(pending)) {
                return { reason: 'transcript_identity_mismatch' };
            }
            const quoteBack = injections.quoteBackStatus(pending);
            if (quoteBack === 'incomplete') {
                return { reason: 'self_ingestion_protection_incomplete' };
            }
            meaningful = true;
            gap = 'open_turn';
            evidenceDigest.update(sourceTurnDigest(pending));
            if (quoteBack !== 'match') {
                const rendered = renderFilteredTurn(filterTurn(pending), pending.turnIndex);
                if (rendered !== null) {
                    turns.push(rendered);
                    chars += rendered.length;
                    while (turns.length > CURRENT_CHAT_EVIDENCE_MAX_TURNS || chars > CURRENT_CHAT_EVIDENCE_MAX_CHARS) {
                        chars -= turns.shift()?.length ?? 0;
                        omitted++;
                    }
                }
            }
        }
    } catch (error) {
        if (!(error instanceof TranscriptReadBudgetError)) {
            throw error;
        }
        // A bounded prefix cannot stand in for the newest source evidence.
        omitted += turns.length;
        turns.length = 0;
        gap = 'scan_limit';
        meaningful = true;
    }
    if (invalid || !chat.current()) {
        return { reason: input.signal.aborted ? 'deadline' : 'source_evidence_changed' };
    }
    return { turns, omitted, meaningful, boundary, gap, digest: evidenceDigest.digest('hex') };
}

function renderContext(
    manifest: TaskStateManifestRow,
    evidence: { turns: string[]; omitted: number; gap?: string },
    current: boolean,
    input: TaskStateChatInput,
): string {
    const nonce = randomUUID();
    const intro = current ? TASK_STATE_CURRENT_INTRODUCTION : TASK_STATE_CHECKPOINT_INTRODUCTION;
    const items = (['objective', 'decisions', 'constraints', 'pending_items'] as const)
        .flatMap((section) => {
            const values =
                section === 'objective' ? (manifest.report.objective ? [manifest.report.objective] : []) : manifest.report[section];
            return values.map((item, itemIndex) => ({
                position: Math.max(
                    ...manifest.sourceLocators
                        .filter((locator) => locator.section === section && locator.itemIndex === itemIndex)
                        .map((locator) => locator.sourceTurnIndex),
                ),
                text: JSON.stringify({
                    [section]: item,
                    source_turn_indices: [
                        ...new Set(
                            manifest.sourceLocators
                                .filter(
                                    (locator) =>
                                        locator.section === section &&
                                        locator.itemIndex === itemIndex &&
                                        locator.nativeSource?.kind !== CODEX_TASK_SOURCE_KIND.projectInstructions,
                                )
                                .map((locator) => locator.sourceTurnIndex),
                        ),
                    ],
                    ...(manifest.sourceLocators.some(
                        (locator) => locator.section === section && locator.itemIndex === itemIndex && locator.nativeSource !== undefined,
                    )
                        ? {
                              source_provenance: manifest.sourceLocators
                                  .filter((locator) => locator.section === section && locator.itemIndex === itemIndex)
                                  .map((locator) => ({
                                      quote_index: locator.quoteIndex,
                                      kind: locator.nativeSource?.kind ?? locator.role,
                                  })),
                          }
                        : {}),
                }),
            }));
        })
        .sort((left, right) => left.position - right.position);
    const units = [...items.map((item) => item.text), ...evidence.turns];
    let dropped = 0;
    const render = (): string =>
        [
            intro,
            servedContextInstructions(nonce),
            dataBlockOpen(nonce),
            JSON.stringify({
                tool: input.tool,
                native_session_id: input.nativeSessionId,
                asOfTurnIndex: manifest.reportingSource.turnIndex,
                omitted_items: Math.min(dropped, items.length),
                ...(evidence.gap === undefined ? {} : { partialCoverageReason: evidence.gap }),
            }),
            ...units,
            ...(evidence.omitted + Math.max(0, dropped - items.length)
                ? [
                      omissionMarker(
                          evidence.omitted + Math.max(0, dropped - items.length),
                          evidence.turns.length - Math.max(0, dropped - items.length),
                          evidence.omitted + evidence.turns.length,
                      ),
                  ]
                : []),
            dataBlockClose(nonce),
        ].join('\n');
    let body = render();
    while (escapeShellSyntax(body).length > CURRENT_CHAT_EVIDENCE_MAX_CHARS && units.length > 0) {
        units.shift();
        dropped++;
        body = render();
    }
    return body;
}

export async function prepareTaskStateContinuation(db: Database.Database, input: TaskStateChatInput & { source: 'compact' | 'resume' }) {
    const chat = await authenticateTaskStateChat(db, input);
    if (!chat) {
        return { reason: 'task_chat_unavailable' };
    }
    try {
        const selected = await selectTaskStateCheckpoint(db, { ...input, transcriptPath: chat.binding.sourcePath, nativeChat: chat });
        if (selected.state !== 'available') {
            await chat.close();
            return { reason: selected.reason };
        }
        const manifest = selected.checkpoint.manifest;
        const evidence = await nativeEvidence(db, chat, input, manifest);
        if ('reason' in evidence) {
            await chat.close();
            return evidence;
        }
        let current = !evidence.meaningful && evidence.gap === undefined;
        if (current && input.tool === 'claude-code' && input.source === 'compact') {
            const fresh = await selectFreshClaudePrecompactManifest(db, { ...input, transcriptPath: chat.binding.sourcePath });
            current = fresh.state === 'available' && fresh.manifest.memoryId === manifest.memoryId;
        }
        if (!chat.current() || !selected.revalidate()) {
            await chat.close();
            return { reason: 'source_state_changed' };
        }
        // An authenticated empty replacement withdraws the agenda. Never fall
        // back to an older report just because the replacement has no items.
        if (manifest.report.objective === null) {
            await chat.close();
            return { reason: 'task_state_empty' };
        }
        const body = renderContext(manifest, evidence, current, input);
        if (escapeShellSyntax(body).length > CURRENT_CHAT_EVIDENCE_MAX_CHARS) {
            await chat.close();
            return { reason: 'task_context_exceeds_budget' };
        }
        // Random data delimiters are framing, not evidence identity.
        const deliveryKey = createHash('sha256')
            .update(
                JSON.stringify({
                    tool: input.tool,
                    nativeId: input.nativeSessionId,
                    generation: chat.binding.sourceGeneration,
                    source: input.source,
                    boundary: evidence.boundary ?? chat.opened.stat.size,
                    manifest,
                    evidenceDigest: evidence.digest,
                    gap: evidence.gap,
                    current,
                }),
            )
            .digest('hex');
        return { body, deliveryKey, current: () => chat.current() && selected.revalidate(), close: chat.close };
    } catch {
        await chat.close().catch(() => undefined);
        return { reason: 'task_context_unavailable' };
    }
}
