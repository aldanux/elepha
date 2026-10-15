// Adapter for ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl[.zst] session files.
//
// Turn boundary has two observed forms: event_msg.payload.type "user_message"
// and a non-synthetic response_item message whose role is "user". A file uses
// one form consistently; the adapter identifies which before parsing so a
// rollout that contains both records does not create duplicate turns. Real
// Some primary rollouts omit the event form entirely, so the response item
// must remain a boundary on its own. Synthetic
// role:"user"/"developer" response_items remain excluded: in particular,
// <environment_context> is a resume marker and never turn content.
//
// File edits arrive as a response_item with payload.type "custom_tool_call"
// and payload.name "apply_patch" - the patch text is a RAW string under
// payload.input (real newlines, not JSON-encoded), not the OpenAI-style
// function_call/arguments envelope. Verified against 542 real apply_patch
// calls across CLI versions 0.136.0-0.147.0: the custom_tool_call envelope
// was 100% of them, 0 used function_call. An earlier version of this adapter
// assumed function_call/arguments without a real sample and missed every
// apply_patch call as a result.
//
// Genuine MCP calls have two observed envelopes. CLI rollouts use
// response_item function_call/function_call_output. Codex Desktop can wrap
// dispatch in a custom `exec` call and emit the completed MCP call as an
// event_msg item_completed/McpToolCall carrying server, id, and result.
// The function_call arguments field really is a JSON-encoded string.
//
// Every payload.type/top-level type this adapter treats as skip is listed
// explicitly below (KNOWN_*). Anything not in one of those sets triggers
// warnUnknownLine() instead of silently falling through - the exact failure
// mode that let the apply_patch envelope bug ship unnoticed.

import { createHash } from 'node:crypto';
import { lstatSync, realpathSync } from 'node:fs';
import { type FileHandle, lstat, opendir, realpath } from 'node:fs/promises';
import path from 'node:path';
import {
    CODEX_TASK_SOURCE_KIND,
    CODEX_TASK_SOURCE_LOOKUP_CODE,
    CODEX_TASK_SOURCE_LOOKUP_MAX_DEPTH,
    CODEX_TASK_SOURCE_LOOKUP_MAX_ENTRIES,
} from '../config/codex.js';
import {
    ELEPHA_MCP_CALL_ID_MAX_BYTES,
    ELEPHA_MCP_NAMESPACE,
    ELEPHA_MCP_RESULTS_PER_TURN_MAX,
    ELEPHA_MCP_RESULTS_PER_TURN_MAX_BYTES,
    SESSION_KIND_PREAMBLE_MAX_BYTES,
    TASK_STATE_REPORT_TOOL,
} from '../config/constants.js';
import { codexHome, codexSessionsRoot, isWithin, toPosix } from '../config/paths.js';
import type {
    EmptySessionAnalysis,
    ParsedToolCall,
    ParseTurnsOptions,
    SessionAdapterTool,
    SessionClassification,
    TaskStateNativeSourceProof,
    TaskStateReport,
} from '../types/index.js';
import {
    boundedMcpResult,
    canonicalTimestamp,
    classifyEmptyJsonlSession,
    consumeTaskStateReportResult,
    createTurnBuilderState,
    type EmptySessionSignals,
    isTaskStateReportCallId,
    JsonlTurnAdapter,
    type LineClass,
    OversizedTranscriptRecordError,
    observeTaskStateReportCall,
    type ParserDecisionTracker,
    readBoundedLines,
    rememberUnmatchedElephaMcpResult,
    resolveAbsolute,
    safeDiscriminator,
    TranscriptReadBudgetError,
    type TurnBuilderState,
    type TurnLifecycleSignal,
    taskStateReportOutcome,
    textValues,
} from './base.js';
import { INTERNAL_COMMAND_NAME, INTERNAL_COMMAND_TAGS } from './internal-command.js';
import { sameTaskStateReportInput } from './task-state-report.js';

const ROLLOUT_ID_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
const EXTERNAL_IMPORT_TURN_PREFIX = 'external-import-turn-';
const ELEPHA_MCP_SERVER = ELEPHA_MCP_NAMESPACE.slice('mcp__'.length);

type TaskSourceLookup =
    | { sourcePath: string; current: () => boolean }
    | { code: (typeof CODEX_TASK_SOURCE_LOOKUP_CODE)[keyof typeof CODEX_TASK_SOURCE_LOOKUP_CODE]; cause?: unknown };

type NativeTaskSourceReadOptions = Pick<ParseTurnsOptions, 'handle' | 'readBudget' | 'signal'> & {
    authorizeCwd: (cwd: string) => boolean;
    reportCallId?: string;
    onSource?: (text: string, proof: TaskStateNativeSourceProof, timestampMs?: number) => void;
};

// Top-level line types this adapter has observed and deliberately ignores
// (none carry turn content; session_meta/turn_context are mined for cwd only).
const KNOWN_TOP_LEVEL_SKIP = new Set([
    'session_meta',
    'turn_context',
    'world_state',
    'compacted',
    'inter_agent_communication_metadata',
    // Codex token accounting: identifiers and usage counters only, with no user or assistant turn content.
    'token_usage_record',
]);

// event_msg.payload.type subtypes other than "user_message". agent_message is
// a higher-volume duplicate of the response_item assistant text we already
// use as the source of truth - intentionally not read here.
const KNOWN_EVENT_MSG_SKIP = new Set([
    'token_count',
    'agent_message',
    'task_started',
    'task_complete',
    'thread_settings_applied',
    // Native goal snapshots are control metadata, never conversation or instructions.
    'thread_goal_updated',
    'patch_apply_end',
    'mcp_tool_call_end',
    'web_search_end',
    'item_completed',
    'context_compacted',
    'turn_aborted',
    'sub_agent_activity',
    'thread_rolled_back',
    // TUI's short thinking header, not chain-of-thought or assistant output.
    // Observed only in a prerelease build; deliberately exclude it.
    'agent_reasoning',
]);

// response_item.payload.type subtypes other than "message", "custom_tool_call", and "function_call".
const KNOWN_RESPONSE_ITEM_SKIP = new Set([
    'reasoning',
    'custom_tool_call_output',
    'function_call_output',
    'web_search_call',
    'tool_search_call',
    'tool_search_output',
    'agent_message', // rare (sub-agent) duplicate of the event_msg subtype of the same name - same "already have this via response_item role:assistant" rationale
]);

// Codex's apply_patch envelope, used both standalone and embedded in shell
// heredocs. A "*** Move to: X" line marks a rename: the file was touched at
// BOTH the old and new path - recording only the source path (or only the
// destination) isn't incomplete data, it's wrong data, since neither alone
// tells a reader where the file actually lives now.
const PATCH_FILE_RE = /\*\*\* (?:Update|Add|Delete) File: ([^\\\n"]+)/g;
const PATCH_MOVE_RE = /\*\*\* Move to: ([^\\\n"]+)/g;

interface CodexMessageContentBlock {
    type: string;
    text?: string;
}

interface CodexPayload {
    type: string;
    role?: string;
    phase?: unknown;
    cwd?: string;
    message?: string;
    name?: string;
    namespace?: string;
    arguments?: string; // function_call: JSON-encoded string
    input?: string; // custom_tool_call: raw string (real newlines)
    content?: CodexMessageContentBlock[];
    call_id?: string;
    output?: unknown;
    item?: {
        type?: unknown;
        id?: unknown;
        server?: unknown;
        tool?: unknown;
        arguments?: unknown;
        status?: unknown;
        result?: unknown;
    };
    started_at_ms?: unknown;
    completed_at_ms?: unknown;
    error?: unknown;
    turn_id?: string;
    source?: { subagent?: { thread_spawn?: unknown } };
}

interface CodexLine {
    timestamp?: string;
    ordinal?: unknown;
    type: string; // "session_meta" | "event_msg" | "response_item" | "turn_context" | ...
    payload?: CodexPayload;
}

interface CodexSessionIndexLine {
    id?: string;
    thread_name?: string;
    updated_at?: string;
}

// The CLI pair names the report tool under the elepha namespace; Desktop's
// McpToolCall item names the server and tool separately.
function isTaskStateReportFunctionCall(payload: CodexPayload): boolean {
    return payload.type === 'function_call' && payload.namespace === ELEPHA_MCP_NAMESPACE && payload.name === TASK_STATE_REPORT_TOOL;
}

function desktopElephaMcpItem(line: CodexLine): CodexPayload['item'] {
    const item = line.payload?.item;
    return line.type === 'event_msg' &&
        line.payload?.type === 'item_completed' &&
        item?.type === 'McpToolCall' &&
        item.server === ELEPHA_MCP_SERVER
        ? item
        : undefined;
}

function hasToolCall(payloadType: string | undefined): boolean {
    return (
        payloadType === 'function_call' ||
        payloadType === 'custom_tool_call' ||
        payloadType === 'web_search_call' ||
        payloadType === 'tool_search_call' ||
        payloadType === 'custom_tool_call_output' ||
        payloadType === 'function_call_output' ||
        payloadType === 'mcp_tool_call_end' ||
        payloadType === 'web_search_end' ||
        payloadType === 'tool_search_output'
    );
}

function emptySessionSignals(line: CodexLine): EmptySessionSignals {
    const payload = line.payload;
    const role = payload?.role;
    const payloadType = payload?.type;
    const isUser = role === 'user' || payloadType === 'user_message';
    const values = textValues(payload?.content ?? payload?.message);

    return {
        userContentSeen: isUser,
        internalCommandRollout: line.type === 'session_meta' && payload?.source?.subagent?.thread_spawn !== undefined,
        internalCommand: isUser && values.some((value) => INTERNAL_COMMAND_NAME.test(value) && INTERNAL_COMMAND_TAGS.test(value)),
        nonInternalUserContent: isUser && values.some((value) => value.trim() !== '' && !INTERNAL_COMMAND_TAGS.test(value)),
        assistantContribution: role === 'assistant' || (line.type === 'event_msg' && payloadType === 'agent_message'),
        abortedPrompt: payloadType === 'turn_aborted',
        toolCall: hasToolCall(payloadType),
    };
}

// session_meta fields that identify what kind of transcript this is. Verified
// against the real corpus rather than assumed.
interface CodexSessionMeta {
    forked_from_id?: string | null;
    history_mode?: unknown;
    history_base?: unknown;
    forked_from_ordinal_exclusive?: unknown;
    parent_thread_id?: string | null;
    thread_source?: string | null;
    agent_path?: string | null;
    agent_nickname?: string | null;
    originator?: string;
    source?: unknown;
    git?: { branch?: string; commit_hash?: string; repository_url?: string | null };
}

// Fork/import precedence belongs to the caller; this predicate identifies
// both observed internal approval formats without treating all children alike.
// A user-spawned subagent always carries its identity; the internal
// adjudicator never does.
export function isCodexGuardianMetadata(meta: CodexSessionMeta): boolean {
    const source = meta.source;
    const subagent = typeof source === 'object' && source !== null && 'subagent' in source ? source.subagent : undefined;
    const guardianSource = typeof subagent === 'object' && subagent !== null && 'other' in subagent && subagent.other === 'guardian';
    return (
        meta.thread_source === 'guardian_review' ||
        guardianSource ||
        (meta.thread_source === 'subagent' && !nonemptyString(meta.agent_path) && !nonemptyString(meta.agent_nickname))
    );
}

function nonemptyString(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0;
}

function hasReferencedPaginatedForkBoundary(first: CodexLine, meta: CodexSessionMeta, firstAtStart: boolean): boolean {
    const base = meta.history_base;
    const cutoff = meta.forked_from_ordinal_exclusive;
    return (
        firstAtStart &&
        first.type === 'session_meta' &&
        meta.history_mode === 'paginated' &&
        nonemptyString(meta.forked_from_id) &&
        typeof cutoff === 'number' &&
        Number.isSafeInteger(cutoff) &&
        cutoff >= 0 &&
        first.ordinal === cutoff &&
        typeof base === 'object' &&
        base !== null &&
        !Array.isArray(base) &&
        'thread_id' in base &&
        nonemptyString(base.thread_id) &&
        'end_ordinal_exclusive' in base &&
        base.end_ordinal_exclusive === cutoff &&
        'end_byte_offset' in base &&
        typeof base.end_byte_offset === 'number' &&
        Number.isSafeInteger(base.end_byte_offset) &&
        base.end_byte_offset >= 0
    );
}

function validKindMetadata(meta: Record<string, unknown>): boolean {
    for (const key of ['forked_from_id', 'parent_thread_id', 'thread_source', 'agent_path', 'agent_nickname']) {
        const value = meta[key];
        if (value !== undefined && value !== null && (typeof value !== 'string' || value.length === 0)) {
            return false;
        }
    }
    const source = meta.source;
    if (source === undefined || source === null || typeof source === 'string') {
        return true;
    }
    if (typeof source !== 'object' || Array.isArray(source)) {
        return false;
    }
    if (!('subagent' in source)) {
        return true;
    }
    const subagent = source.subagent;
    if (!subagent || typeof subagent !== 'object' || Array.isArray(subagent)) {
        return false;
    }
    return !('other' in subagent && (typeof subagent.other !== 'string' || subagent.other.length === 0));
}

// This revision repairs guardian exclusions, not every historical classifier.
// Ordinary/fork headers finish here. Only guardian candidates require a task
// boundary to preserve external-import precedence. A chunk may buffer bytes
// after session_meta; none are interpreted before its cwd is authorized.
export async function readCodexKindPreamble(
    filePath: string,
    handle: FileHandle,
    authorizeHeader: (cwd: string, nativeId: string) => boolean,
    options?: Pick<ParseTurnsOptions, 'readBudget' | 'signal'>,
): Promise<{
    nativeId: string;
    cwd: string;
    guardian: boolean;
    malformed: boolean;
    root: boolean;
}> {
    let meta: (CodexSessionMeta & { id: string; cwd: string }) | undefined;
    let malformed = false;
    for await (const { text } of readBoundedLines(filePath, {
        ...options,
        handle,
        maxReadBytes: SESSION_KIND_PREAMBLE_MAX_BYTES,
        maxRecordBytes: SESSION_KIND_PREAMBLE_MAX_BYTES,
    })) {
        const line: unknown = JSON.parse(text);
        if (
            !line ||
            typeof line !== 'object' ||
            !('type' in line) ||
            !('payload' in line) ||
            !line.payload ||
            typeof line.payload !== 'object'
        ) {
            throw new Error('malformed classification preamble');
        }
        const payload = line.payload;
        if (!meta) {
            if (
                line.type !== 'session_meta' ||
                !('id' in payload) ||
                typeof payload.id !== 'string' ||
                !payload.id ||
                !('cwd' in payload) ||
                typeof payload.cwd !== 'string' ||
                !path.isAbsolute(payload.cwd)
            ) {
                throw new Error('missing or malformed session metadata');
            }
            meta = payload as CodexSessionMeta & { id: string; cwd: string };
            malformed = !validKindMetadata(payload as Record<string, unknown>);
            if (!authorizeHeader(meta.cwd, meta.id)) {
                throw new Error('session metadata cwd is not currently authorized');
            }
            if (!isCodexGuardianMetadata(meta) || nonemptyString(meta.forked_from_id)) {
                return {
                    nativeId: meta.id,
                    cwd: meta.cwd,
                    guardian: false,
                    malformed,
                    root:
                        !nonemptyString(meta.parent_thread_id) &&
                        meta.thread_source !== 'subagent' &&
                        !(meta.source !== null && typeof meta.source === 'object' && 'subagent' in meta.source),
                };
            }
        }
        if (line.type === 'event_msg' && 'turn_id' in payload && typeof payload.turn_id === 'string' && payload.turn_id !== '') {
            return {
                nativeId: meta.id,
                cwd: meta.cwd,
                guardian: !payload.turn_id.startsWith(EXTERNAL_IMPORT_TURN_PREFIX),
                malformed,
                root: false,
            };
        }
    }
    throw new Error('classification preamble has no task boundary');
}

function extractPatchFilePaths(input: string | undefined, cwd: string | undefined): string[] {
    if (!input) {
        return [];
    }
    const paths = new Set<string>();
    for (const match of input.matchAll(PATCH_FILE_RE)) {
        const raw = match[1]?.trim();
        if (raw) {
            paths.add(resolveAbsolute(raw, cwd ?? process.cwd()));
        }
    }
    for (const match of input.matchAll(PATCH_MOVE_RE)) {
        const raw = match[1]?.trim();
        if (raw) {
            paths.add(resolveAbsolute(raw, cwd ?? process.cwd()));
        }
    }
    return [...paths];
}

// The `exec` custom tool carries a JavaScript PROGRAM, not a command string -
// it can batch N shell commands through Promise.all, and it can carry an
// apply_patch heredoc inline as a JS string literal
// (`const patch = "*** Begin Patch\n*** Update File: ..."`).
//
// Those embedded patches are real file writes in the identical envelope
// extractPatchFilePaths already parses; they were simply never fed to it,
// because extraction was gated on the tool NAME being "apply_patch". Measured
// against the real corpus: 434 of 3,870 exec/exec_command calls carry patch
// paths, 349 of them under name "exec" - i.e. previously dropped on the floor.
//
// Deliberately NOT attempted here: recovering paths from arbitrary shell
// argument text (sed/rg/npm targets). That is a further ~20% of calls but it
// is heuristic and produced false positives (glob artifacts) in measurement.
// Extraction stays deterministic.

// function_call.arguments is JSON-encoded, including any embedded patch.
// Invalid JSON falls back to the raw text.
function decodeArguments(argumentsRaw: string | undefined): string | undefined {
    if (!argumentsRaw) {
        return undefined;
    }
    try {
        const parsed = JSON.parse(argumentsRaw) as Record<string, unknown>;
        return Object.values(parsed)
            .filter((v): v is string => typeof v === 'string')
            .join('\n');
    } catch {
        return argumentsRaw;
    }
}

function extractExecFilePaths(input: string | undefined, cwd: string | undefined): string[] {
    if (!input?.includes('*** ')) {
        return [];
    }
    return extractPatchFilePaths(input, cwd);
}

// read_file is an MCP tool call carrying an explicit file_path argument - the
// Codex-side parity for Claude Code's Read. Low volume but deterministic (65
// calls in the local corpus; a 30-day slice happens to contain none, which is
// NOT evidence the envelope is gone - a dedicated fixture guards it).
function extractReadFileePaths(name: string | undefined, argumentsRaw: string | undefined, cwd: string | undefined): string[] {
    if (name !== 'read_file' || !argumentsRaw) {
        return [];
    }
    try {
        const args = JSON.parse(argumentsRaw) as { file_path?: string; projectPath?: string };
        if (typeof args.file_path !== 'string' || args.file_path.length === 0) {
            return [];
        }
        return [resolveAbsolute(args.file_path, args.projectPath ?? cwd ?? process.cwd())];
    } catch {
        return [];
    }
}

type UserBoundary = 'event_msg' | 'response_item';

interface UserBoundaryState {
    sawUserResponse: boolean;
    boundary?: UserBoundary;
}

export class CodexAdapter extends JsonlTurnAdapter {
    readonly tool: SessionAdapterTool = 'codex';
    readonly watchGlobs = ['*/*/*/rollout-*.jsonl'];
    // session_meta and turn_context set the working directory, surface and
    // branch for every following turn, and a session may declare them only
    // once in its header.
    override readonly carriesContextAcrossTurns = true;
    private readonly userBoundaryByFile = new Map<string, UserBoundary>();
    private readonly desktopMcpCallIds = new WeakMap<TurnBuilderState, Set<string>>();

    matches(filePath: string): boolean {
        return (
            isWithin(codexSessionsRoot(), filePath) &&
            path.basename(filePath).startsWith('rollout-') &&
            (toPosix(filePath).endsWith('.jsonl') || toPosix(filePath).endsWith('.jsonl.zst'))
        );
    }

    nativeSessionId(filePath: string): string {
        const m = ROLLOUT_ID_RE.exec(path.basename(filePath));
        return m ? m[1] : path.basename(filePath, '.jsonl');
    }

    async authenticateTaskStateMetadataTail(
        filePath: string,
        indexedCursor: string,
        observedCursor: string,
        options: Pick<ParseTurnsOptions, 'handle' | 'readBudget'>,
    ): Promise<boolean> {
        if (!options.handle || !options.readBudget) {
            return false;
        }
        const indexed = await this.authenticateCursor(indexedCursor, options.handle, options.readBudget);
        const observed = await this.authenticateCursor(observedCursor, options.handle, options.readBudget);
        if (!indexed || !observed || indexed.nextTurnIndex !== observed.nextTurnIndex || indexed.byteOffset >= observed.byteOffset) {
            return false;
        }
        let offset = indexed.byteOffset;
        for await (const record of readBoundedLines(filePath, { ...options, start: offset, maxReadBytes: observed.byteOffset - offset })) {
            if (!record.terminated) {
                return false;
            }
            let line: CodexLine;
            try {
                line = JSON.parse(record.text) as CodexLine;
            } catch {
                return false;
            }
            // This exact native record cannot contribute conversation, cwd,
            // report calls/results, or lifecycle closure. Other tails abstain.
            if (line.type !== 'event_msg' || line.payload?.type !== 'thread_settings_applied') {
                return false;
            }
            offset += record.byteLength;
            if (offset === observed.byteOffset) {
                return true;
            }
        }
        return false;
    }

    async readInitialTaskContext(filePath: string, options: NativeTaskSourceReadOptions): Promise<boolean> {
        let byteStart = 0;
        for await (const record of readBoundedLines(filePath, { ...options, maxReadBytes: SESSION_KIND_PREAMBLE_MAX_BYTES })) {
            if (!record.terminated) {
                return false;
            }
            const line = JSON.parse(record.text) as CodexLine;
            const payload = line.payload;
            if (this.isCompactionBoundaryLine(line)) {
                return true;
            }
            const cwd = this.cwdOf(line);
            if ((line.type === 'session_meta' || line.type === 'turn_context') && (!cwd || !options.authorizeCwd(cwd))) {
                return false;
            }
            if (line.type === 'response_item' && payload?.type === 'message' && payload.role === 'user') {
                if (!this.isResumeMarkerLine(line)) {
                    return true;
                }
                // The native initial package has separate instruction and
                // environment items. A heading in a conversation is no proof.
                const content = payload.content ?? [];
                const environment = content.some(
                    (block) =>
                        block.type === 'input_text' &&
                        block.text?.trim().startsWith('<environment_context>') &&
                        block.text.trim().endsWith('</environment_context>'),
                );
                if (environment && options.onSource) {
                    content.forEach((block, contentIndex) => {
                        const text = block.text?.trim();
                        const opening = '\n\n<INSTRUCTIONS>';
                        const start = text?.indexOf(opening) ?? -1;
                        if (
                            block.type !== 'input_text' ||
                            !text?.startsWith('# AGENTS.md instructions for ') ||
                            start < 0 ||
                            !text.endsWith('</INSTRUCTIONS>')
                        ) {
                            return;
                        }
                        options.onSource?.(text.slice(start + opening.length, -'</INSTRUCTIONS>'.length), {
                            kind: CODEX_TASK_SOURCE_KIND.projectInstructions,
                            byteStart,
                            byteEnd: byteStart + record.byteLength,
                            recordDigest: createHash('sha256').update(record.text).digest('hex'),
                            contentIndex,
                        });
                    });
                }
            }
            if (
                (line.type === 'event_msg' && payload?.type === 'user_message') ||
                (line.type === 'response_item' &&
                    (payload?.role === 'assistant' || payload?.type === 'function_call' || payload?.type === 'custom_tool_call'))
            ) {
                return true;
            }
            byteStart += record.byteLength;
        }
        return !options.signal?.aborted;
    }

    async readAssistantBeforeTaskReport(
        filePath: string,
        options: NativeTaskSourceReadOptions & { start: number; end: number; reportCallId: string; report: TaskStateReport },
    ): Promise<false | { assistantBeforeMs?: number }> {
        let byteStart = options.start;
        for await (const record of readBoundedLines(filePath, { ...options, maxReadBytes: options.end - options.start })) {
            if (!record.terminated) {
                return false;
            }
            const line = JSON.parse(record.text) as CodexLine;
            const payload = line.payload;
            const cwd = this.cwdOf(line);
            if (cwd && !options.authorizeCwd(cwd)) {
                return false;
            }
            if (
                line.type === 'response_item' &&
                payload &&
                isTaskStateReportFunctionCall(payload) &&
                payload.call_id === options.reportCallId
            ) {
                return {};
            }
            const desktop = desktopElephaMcpItem(line);
            if (desktop?.tool === TASK_STATE_REPORT_TOOL && desktop.id === options.reportCallId) {
                const started = payload?.started_at_ms;
                const completed = payload?.completed_at_ms;
                if (
                    typeof started !== 'number' ||
                    !Number.isFinite(started) ||
                    started < 0 ||
                    typeof completed !== 'number' ||
                    !Number.isFinite(completed) ||
                    completed < started
                ) {
                    return false;
                }
                const state = createTurnBuilderState();
                this.observeElephaMcp(state, line);
                const outcome = taskStateReportOutcome(state);
                if (
                    !outcome ||
                    !('report' in outcome) ||
                    outcome.report.callId !== options.reportCallId ||
                    !sameTaskStateReportInput(outcome.report, options.report)
                ) {
                    return false;
                }
                return { assistantBeforeMs: started };
            }
            if (line.type === 'response_item' && payload?.type === 'message' && payload.role === 'assistant') {
                (payload.content ?? []).forEach((block, contentIndex) => {
                    if ((block.type === 'output_text' || block.type === 'text') && typeof block.text === 'string') {
                        options.onSource?.(
                            block.text,
                            {
                                kind: CODEX_TASK_SOURCE_KIND.assistantBeforeReport,
                                byteStart,
                                byteEnd: byteStart + record.byteLength,
                                recordDigest: createHash('sha256').update(record.text).digest('hex'),
                                contentIndex,
                            },
                            line.timestamp === undefined ? undefined : Date.parse(line.timestamp),
                        );
                    }
                });
            }
            byteStart += record.byteLength;
            if (byteStart >= options.end) {
                break;
            }
        }
        return false;
    }

    async resolveTaskStateSource(nativeId: string, signal: AbortSignal): Promise<TaskSourceLookup> {
        if (nativeId.length !== 36 || !ROLLOUT_ID_RE.test(`${nativeId}.jsonl`)) {
            return { code: CODEX_TASK_SOURCE_LOOKUP_CODE.invalidId };
        }
        const configuredRoot = codexSessionsRoot();
        const snapshots = new Map<string, Awaited<ReturnType<typeof lstat>>>();
        let root: string;
        let entries = 0;
        let candidate: string | undefined;
        const unchanged = (before: Awaited<ReturnType<typeof lstat>>, after: Awaited<ReturnType<typeof lstat>>): boolean =>
            after.isDirectory() &&
            before.dev === after.dev &&
            before.ino === after.ino &&
            before.mtimeMs === after.mtimeMs &&
            before.ctimeMs === after.ctimeMs;
        const current = (): boolean => {
            try {
                if (signal.aborted || realpathSync(configuredRoot) !== root) {
                    return false;
                }
                for (const [directory, before] of snapshots) {
                    if (signal.aborted || !unchanged(before, lstatSync(directory))) {
                        return false;
                    }
                }
                return true;
            } catch {
                return false;
            }
        };
        const walk = async (directory: string, depth: number): Promise<void> => {
            if (signal.aborted) {
                throw { code: CODEX_TASK_SOURCE_LOOKUP_CODE.incomplete };
            }
            const before = await lstat(directory);
            if (!before.isDirectory()) {
                throw { code: CODEX_TASK_SOURCE_LOOKUP_CODE.unreadable };
            }
            snapshots.set(directory, before);
            const opened = await opendir(directory);
            try {
                while (!signal.aborted) {
                    const entry = await opened.read();
                    if (!entry) {
                        break;
                    }
                    if (++entries > CODEX_TASK_SOURCE_LOOKUP_MAX_ENTRIES) {
                        throw { code: CODEX_TASK_SOURCE_LOOKUP_CODE.incomplete };
                    }
                    const entryPath = path.join(directory, entry.name);
                    const locator = entry.name.endsWith('.zst') ? entry.name.slice(0, -'.zst'.length) : entry.name;
                    if (entry.name.startsWith('rollout-') && this.nativeSessionId(locator) === nativeId) {
                        if (!entry.isFile() && !entry.isSymbolicLink()) {
                            throw { code: CODEX_TASK_SOURCE_LOOKUP_CODE.unreadable };
                        }
                        if (candidate) {
                            throw { code: CODEX_TASK_SOURCE_LOOKUP_CODE.ambiguous };
                        }
                        candidate = entryPath;
                    } else if (entry.isDirectory()) {
                        if (depth >= CODEX_TASK_SOURCE_LOOKUP_MAX_DEPTH) {
                            throw { code: CODEX_TASK_SOURCE_LOOKUP_CODE.incomplete };
                        }
                        await walk(entryPath, depth + 1);
                    } else if (!entry.isFile()) {
                        // An unreadable or linked branch cannot prove uniqueness.
                        throw { code: CODEX_TASK_SOURCE_LOOKUP_CODE.unreadable };
                    }
                }
                if (signal.aborted) {
                    throw { code: CODEX_TASK_SOURCE_LOOKUP_CODE.incomplete };
                }
            } finally {
                await opened.close();
            }
        };
        const lookup = async (): Promise<TaskSourceLookup> => {
            try {
                try {
                    root = await realpath(configuredRoot);
                } catch (cause) {
                    return {
                        code:
                            (cause as NodeJS.ErrnoException).code === 'ENOENT'
                                ? CODEX_TASK_SOURCE_LOOKUP_CODE.missing
                                : CODEX_TASK_SOURCE_LOOKUP_CODE.unreadable,
                        cause,
                    };
                }
                await walk(root, 0);
                if (!current()) {
                    return { code: CODEX_TASK_SOURCE_LOOKUP_CODE.changed };
                }
                return candidate ? { sourcePath: candidate, current } : { code: CODEX_TASK_SOURCE_LOOKUP_CODE.missing };
            } catch (cause) {
                const code = (cause as NodeJS.ErrnoException).code;
                return {
                    code:
                        code === 'ENOENT'
                            ? CODEX_TASK_SOURCE_LOOKUP_CODE.changed
                            : (Object.values(CODEX_TASK_SOURCE_LOOKUP_CODE).find((value) => value === code) ??
                              CODEX_TASK_SOURCE_LOOKUP_CODE.unreadable),
                    cause,
                };
            }
        };
        // Directory reads have no AbortSignal support. Return on the shared
        // deadline; a late read stops traversing and closes its owned handles.
        let abort: () => void = () => {};
        const cancelled = new Promise<TaskSourceLookup>((resolve) => {
            abort = () => resolve({ code: CODEX_TASK_SOURCE_LOOKUP_CODE.incomplete });
            signal.addEventListener('abort', abort, { once: true });
            if (signal.aborted) {
                abort();
            }
        });
        try {
            return await Promise.race([lookup(), cancelled]);
        } finally {
            signal.removeEventListener('abort', abort);
        }
    }

    // Codex keeps the AI-generated thread name in its session index, separate
    // from the rollout. A missing or incomplete index is normal while Codex
    // is still writing, so leave the prompt-derived fallback in place.
    protected override async readSessionAiTitle(filePath: string): Promise<string | undefined> {
        const sessionId = this.nativeSessionId(filePath);
        let latestTitle: string | undefined;
        let latestUpdatedAt: number | undefined;
        let lastTitleWithoutUsableTimestamp: string | undefined;
        try {
            for await (const { text } of readBoundedLines(path.join(codexHome(), 'session_index.jsonl'))) {
                let line: CodexSessionIndexLine;
                try {
                    line = JSON.parse(text) as CodexSessionIndexLine;
                } catch {
                    continue;
                }
                if (line.id !== sessionId || typeof line.thread_name !== 'string') {
                    continue;
                }

                const updatedAt = Date.parse(line.updated_at ?? '');
                if (!Number.isFinite(updatedAt)) {
                    lastTitleWithoutUsableTimestamp = line.thread_name;
                    continue;
                }
                if (latestUpdatedAt === undefined || updatedAt >= latestUpdatedAt) {
                    latestTitle = line.thread_name;
                    latestUpdatedAt = updatedAt;
                }
            }
        } catch {
            // The daemon's transcript readability report must not turn a
            // missing or temporarily malformed title index into ingest noise.
        }
        return latestTitle ?? lastTitleWithoutUsableTimestamp;
    }

    // Codex has emitted both user-turn envelopes. When an event_msg is present
    // before the response, it is the historical boundary; otherwise the
    // role:user response_item is the complete record. Resolve that once per
    // parse so a rollout containing the duplicate pair does not emit twice.
    // Which record opens a user turn: newer Codex writes an event_msg
    // user_message beside the response_item prompt, older Codex only the
    // response_item. The first decisive record settles it for the whole
    // transcript, and the decision is recorded with every cursor so a resumed
    // parse never rescans from the start to make it again.
    protected override decisionTracker(): ParserDecisionTracker {
        return {
            initial: (): UserBoundaryState => ({ sawUserResponse: false }),
            observe: (state, raw) => {
                const current = state as UserBoundaryState;
                if (current.boundary !== undefined) {
                    return current;
                }
                const line = raw as CodexLine;
                const payload = line?.payload;
                if (line?.type === 'event_msg' && payload?.type === 'user_message') {
                    return { ...current, boundary: 'event_msg' };
                }
                if (
                    line?.type === 'response_item' &&
                    payload?.type === 'message' &&
                    payload.role === 'user' &&
                    !this.isResumeMarkerLine(line)
                ) {
                    return { ...current, sawUserResponse: true };
                }
                // A user prompt followed by the assistant without an
                // event_msg is the response_item-only format. No later
                // transcript line can turn that completed turn into the
                // duplicate form.
                if (
                    current.sawUserResponse &&
                    line?.type === 'response_item' &&
                    payload?.type === 'message' &&
                    payload.role === 'assistant'
                ) {
                    return { ...current, boundary: 'response_item' };
                }
                return current;
            },
            decided: (state) => {
                const boundary = (state as UserBoundaryState | undefined)?.boundary;
                return boundary === undefined ? undefined : { userBoundary: boundary };
            },
            valid: (decisions) => decisions.userBoundary === 'event_msg' || decisions.userBoundary === 'response_item',
        };
    }

    // Undecided keeps the response envelope, the conservative default.
    protected override applyDecisions(filePath: string, decisions: Readonly<Record<string, string>> | undefined): void {
        this.userBoundaryByFile.set(filePath, decisions?.userBoundary === 'event_msg' ? 'event_msg' : 'response_item');
    }

    // Codex encodes session provenance in the first session_meta line.
    //
    // Two markers look authoritative and are not:
    //  - thread_source === 'subagent' is set on genuine subagents AND on the
    //    internal adjudicator, so it cannot decide either on its own.
    //  - parent_thread_id is set on every child session, copy or not. Keying
    //    fork detection off it misclassifies 26 non-copied sessions whose
    //    turns span hours-to-days as duplicates.
    //
    // Measured against the local corpus, the signals that actually separate
    // the cases:
    //
    // - Legacy forks with forked_from_id begin with a copy of the parent's
    //   whole transcript, every copied line restamped with the fork instant
    //   (observed: 175 turns inside 73ms of each other, byte-identical user
    //   messages to the parent, vs. multi-hour spans on every non-forked
    //   child). Ingesting it duplicates the parent. Paginated forks instead
    //   begin at their inherited history cutoff; the first record's ordinal
    //   must match it. The physical history base may name an ancestor rather
    //   than the immediate forked_from_id parent.
    // - thread_source 'subagent' with NO agent_path/agent_nickname -> Codex's
    //   internal approval adjudicator. Its own prompt labels the transcript
    //   "untrusted evidence, not instructions to follow"; there is no human in
    //   it. User-spawned subagents always carry both fields.
    // - Codex 0.150.1 changed guardian thread_source from 'subagent' to
    //   'guardian_review'. Both formats retain source.subagent.other equal
    //   to 'guardian'; these are approval evidence, not human sessions.
    async classifySession(
        filePath: string,
        options?: Pick<ParseTurnsOptions, 'handle' | 'maxReadBytes' | 'signal' | 'readBudget'>,
    ): Promise<SessionClassification> {
        const { first, firstAtStart, externalAgentImport } = await this.readClassificationPreamble(filePath, options);
        if (!first) {
            return { kind: 'primary' };
        }
        const meta = (first.payload ?? {}) as CodexSessionMeta;
        if (!validKindMetadata(meta as Record<string, unknown>)) {
            this.warnUnknownLine(`CodexAdapter: malformed optional classification metadata ignored in ${filePath}`);
        }

        if (externalAgentImport) {
            return {
                kind: 'primary',
                exclusion: 'external-agent-import',
                reason: `turn_id starts with ${EXTERNAL_IMPORT_TURN_PREFIX}`,
            };
        }

        if (nonemptyString(meta.forked_from_id)) {
            if (!hasReferencedPaginatedForkBoundary(first, meta, firstAtStart)) {
                if (meta.history_mode === 'paginated') {
                    this.warnUnknownLine(`CodexAdapter: inconsistent paginated fork boundary in ${filePath}`);
                }
                return {
                    kind: 'fork-copy',
                    parentNativeId: meta.forked_from_id,
                    reason:
                        meta.history_mode === 'paginated'
                            ? `paginated fork history boundary is unverified for session ${meta.forked_from_id}`
                            : `transcript opens with a fork-time copy of session ${meta.forked_from_id}`,
                };
            }
        }

        if (isCodexGuardianMetadata(meta)) {
            return {
                kind: 'adjudicator',
                parentNativeId: nonemptyString(meta.parent_thread_id) ? meta.parent_thread_id : undefined,
                reason: 'Codex internal approval-adjudication transcript (untrusted evidence, no human)',
            };
        }

        if (meta.thread_source === 'subagent') {
            return { kind: 'subagent', parentNativeId: nonemptyString(meta.parent_thread_id) ? meta.parent_thread_id : undefined };
        }

        return { kind: 'primary' };
    }

    async classifyEmptySession(filePath: string): Promise<EmptySessionAnalysis | undefined> {
        return classifyEmptyJsonlSession(filePath, (line) => emptySessionSignals(line as CodexLine));
    }

    // Imported external-agent rollouts have no discriminator in session_meta;
    // Codex puts it on the first task event instead. Read parsed fields from the
    // JSONL preamble and stop at the first turn_id: matching text elsewhere in a
    // prompt, tool payload, or instruction block must never exclude a session.
    private async readClassificationPreamble(
        filePath: string,
        options?: Pick<ParseTurnsOptions, 'handle' | 'maxReadBytes' | 'signal' | 'readBudget'>,
    ): Promise<{ first: CodexLine | undefined; firstAtStart: boolean; externalAgentImport: boolean }> {
        let first: CodexLine | undefined;
        let firstAtStart = true;

        try {
            for await (const { text } of readBoundedLines(filePath, {
                handle: options?.handle,
                maxReadBytes: options?.maxReadBytes,
                signal: options?.signal,
                readBudget: options?.readBudget,
            })) {
                let line: CodexLine;
                try {
                    line = JSON.parse(text) as CodexLine;
                } catch {
                    if (!first) {
                        firstAtStart = false;
                    }
                    continue;
                }

                first ??= line;
                const turnId = line.type === 'event_msg' ? line.payload?.turn_id : undefined;
                if (typeof turnId === 'string') {
                    return { first, firstAtStart, externalAgentImport: turnId.startsWith(EXTERNAL_IMPORT_TURN_PREFIX) };
                }
            }
        } catch (error) {
            if (
                error instanceof OversizedTranscriptRecordError ||
                (options?.maxReadBytes !== undefined && error instanceof TranscriptReadBudgetError)
            ) {
                throw error;
            }
            // The daemon's file-level readability guard owns the visible alert.
        }

        return { first, firstAtStart, externalAgentImport: false };
    }

    protected cwdOf(line: unknown): string | undefined {
        const l = line as CodexLine;
        if (l.type === 'session_meta' || l.type === 'turn_context') {
            return typeof l.payload?.cwd === 'string' ? l.payload.cwd : undefined;
        }
        return undefined;
    }

    protected timestampOf(line: unknown): string | undefined {
        const l = line as CodexLine;
        return typeof l.timestamp === 'string' ? l.timestamp : undefined;
    }

    protected surfaceOf(line: unknown): string | undefined {
        const l = line as CodexLine;
        if (l.type !== 'session_meta') {
            return undefined;
        }
        const meta = l.payload as unknown as CodexSessionMeta;
        return typeof meta.originator === 'string' ? meta.originator : undefined;
    }

    protected branchOf(line: unknown): string | undefined {
        const l = line as CodexLine;
        if (l.type !== 'session_meta') {
            return undefined;
        }
        const meta = l.payload as unknown as CodexSessionMeta;
        return typeof meta.git?.branch === 'string' ? meta.git.branch : undefined;
    }

    protected isExternalFetchLine(line: unknown): boolean {
        const l = line as CodexLine;
        return l.type === 'response_item' && l.payload?.type === 'web_search_call';
    }

    // `<environment_context>` resume marker. A marker either starts
    // a content item directly or is appended after a reloaded instruction block
    // in that same item. Matching the complete closing tag avoids treating
    // ordinary prose that merely mentions "environment_context" as a marker.
    protected isCompactionBoundaryLine(line: unknown): boolean {
        const value = line as CodexLine;
        return value.type === 'compacted' || (value.type === 'event_msg' && value.payload?.type === 'context_compacted');
    }

    protected isResumeMarkerLine(line: unknown): boolean {
        const l = line as CodexLine;
        if (l.type !== 'response_item' || l.payload?.type !== 'message' || l.payload.role !== 'user') {
            return false;
        }
        return (l.payload.content ?? []).some((block) => {
            const text = block.text?.trim();
            return (
                text?.startsWith('<environment_context>') ||
                (text?.endsWith('</environment_context>') === true && text.includes('\n<environment_context>'))
            );
        });
    }

    protected classify(line: unknown, filePath: string): LineClass {
        const l = line as CodexLine;
        const p = l.payload;
        if (!p) {
            return 'skip';
        }

        if (l.type === 'event_msg') {
            if (p.type === 'user_message') {
                return this.userBoundaryByFile.get(filePath) === 'event_msg' ? 'boundary' : 'skip';
            }
            if (!KNOWN_EVENT_MSG_SKIP.has(p.type)) {
                this.warnUnrecognizedRecord(
                    `CodexAdapter: unrecognized event_msg.payload.type "${safeDiscriminator(p.type)}" in ${filePath}`,
                );
            }
            return 'skip';
        }

        if (l.type === 'response_item') {
            if (p.type === 'message') {
                if (p.role === 'assistant') {
                    if (p.phase !== undefined && p.phase !== 'commentary' && p.phase !== 'final_answer') {
                        this.warnUnknownLine(`CodexAdapter: unrecognized assistant phase "${safeDiscriminator(p.phase)}" in ${filePath}`);
                    }
                    return 'content';
                }
                // This is the portable user-turn record. The only role:user
                // variant that may never open a turn is the synthetic resume
                // marker; it is boundary metadata, not human input.
                return p.role === 'user' && !this.isResumeMarkerLine(l) && this.userBoundaryByFile.get(filePath) === 'response_item'
                    ? 'boundary'
                    : 'skip';
            }
            if (p.type === 'custom_tool_call' || p.type === 'function_call') {
                return 'content';
            }
            if (!KNOWN_RESPONSE_ITEM_SKIP.has(p.type)) {
                this.warnUnrecognizedRecord(
                    `CodexAdapter: unrecognized response_item.payload.type "${safeDiscriminator(p.type)}" in ${filePath}`,
                );
            }
            return 'skip';
        }

        if (!KNOWN_TOP_LEVEL_SKIP.has(l.type)) {
            this.warnUnrecognizedRecord(`CodexAdapter: unrecognized top-level type "${safeDiscriminator(l.type)}" in ${filePath}`);
        }
        return 'skip';
    }

    protected observeToolCallState(state: TurnBuilderState, line: unknown): void {
        const l = line as CodexLine;
        const payload = l.payload;
        if (l.type !== 'response_item' || typeof payload?.call_id !== 'string') {
            return;
        }
        if (payload.type === 'function_call' || payload.type === 'custom_tool_call') {
            state.openToolCallIds.add(payload.call_id);
        } else if (payload.type === 'function_call_output' || payload.type === 'custom_tool_call_output') {
            state.openToolCallIds.delete(payload.call_id);
        }
    }

    protected turnLifecycleSignal(line: unknown): TurnLifecycleSignal | undefined {
        const l = line as CodexLine;
        const payload = l.payload;
        if (l.type !== 'event_msg' || !payload) {
            return undefined;
        }
        if (payload.type === 'task_started') {
            return { phase: 'started', id: typeof payload.turn_id === 'string' ? payload.turn_id : undefined };
        }
        if (payload.type === 'task_complete') {
            return {
                phase: payload.error === undefined || payload.error === null ? 'finished' : 'failed',
                id: typeof payload.turn_id === 'string' ? payload.turn_id : undefined,
            };
        }
        if (payload.type === 'turn_aborted') {
            return { phase: 'aborted', id: typeof payload.turn_id === 'string' ? payload.turn_id : undefined };
        }
        return undefined;
    }

    protected observeElephaMcp(state: TurnBuilderState, line: unknown): void {
        const l = line as CodexLine;
        const payload = l.payload;
        if (!payload) {
            return;
        }
        if (l.type === 'event_msg' && payload.type === 'item_completed') {
            const item = desktopElephaMcpItem(l);
            if (!item) {
                return;
            }
            if (item.tool === TASK_STATE_REPORT_TOOL) {
                // One Desktop item carries both the call and its result.
                const result = item.result;
                const isError =
                    (item.status !== undefined && item.status !== 'completed') ||
                    (result !== null && typeof result === 'object' && (result as { isError?: unknown }).isError === true);
                observeTaskStateReportCall(state, 'codex-desktop', item.id, item.arguments);
                consumeTaskStateReportResult(state, 'codex-desktop', item.id, result, isError);
                return;
            }
            const callId = item.id;
            if (typeof callId === 'string' && this.desktopCallsFor(state).has(callId)) {
                state.elephaMcpCoverageFailure = 'duplicate-call-id';
                return;
            }
            const existingReceipt =
                typeof callId === 'string' ? state.elephaMcpResultReceipts.find((receipt) => receipt.callId === callId) : undefined;
            const resultValue = this.desktopMcpResultValue(item.result);
            if (existingReceipt) {
                const duplicate = boundedMcpResult(resultValue);
                if (duplicate.state === 'incomplete') {
                    state.elephaMcpCoverageFailure = duplicate.reason;
                } else if (duplicate.body !== existingReceipt.body) {
                    state.elephaMcpCoverageFailure = 'duplicate-call-id';
                } else {
                    this.desktopCallsFor(state).add(callId as string);
                }
                return;
            }
            if (typeof callId === 'string' && state.elephaMcpCallIds.has(callId)) {
                this.desktopCallsFor(state).add(callId);
                this.recordElephaMcpResult(state, callId, resultValue, l.timestamp);
                return;
            }
            const registered = this.registerElephaMcpCall(state, callId);
            if (registered === undefined) {
                return;
            }
            this.desktopCallsFor(state).add(registered);
            this.recordElephaMcpResult(state, registered, resultValue, l.timestamp);
            return;
        }
        if (l.type !== 'response_item') {
            return;
        }
        if (isTaskStateReportFunctionCall(payload)) {
            observeTaskStateReportCall(state, 'codex-cli', payload.call_id, payload.arguments);
            return;
        }
        if (payload.type === 'function_call' && payload.namespace === ELEPHA_MCP_NAMESPACE) {
            const callId = payload.call_id;
            if (typeof callId === 'string' && this.desktopCallsFor(state).has(callId)) {
                return;
            }
            this.registerElephaMcpCall(state, callId);
            return;
        }
        if (payload.type !== 'function_call_output') {
            return;
        }
        const callId = payload.call_id;
        if (consumeTaskStateReportResult(state, 'codex-cli', callId, payload.output, false)) {
            return;
        }
        if (typeof callId === 'string' && this.desktopCallsFor(state).has(callId)) {
            const receipt = state.elephaMcpResultReceipts.find((candidate) => candidate.callId === callId);
            const duplicate = boundedMcpResult(payload.output);
            if (duplicate.state === 'incomplete') {
                state.elephaMcpCoverageFailure = duplicate.reason;
            } else if (!receipt || duplicate.body !== receipt.body) {
                state.elephaMcpCoverageFailure = 'duplicate-call-id';
            }
            return;
        }
        this.recordElephaMcpResult(state, callId, payload.output, l.timestamp);
    }

    private desktopCallsFor(state: TurnBuilderState): Set<string> {
        let calls = this.desktopMcpCallIds.get(state);
        if (!calls) {
            calls = new Set();
            this.desktopMcpCallIds.set(state, calls);
        }
        return calls;
    }

    private desktopMcpResultValue(result: unknown): unknown {
        if (result && typeof result === 'object' && !Array.isArray(result) && 'content' in result) {
            return (result as { content: unknown }).content;
        }
        return result;
    }

    private registerElephaMcpCall(state: TurnBuilderState, callId: unknown): string | undefined {
        if (typeof callId !== 'string' || callId === '') {
            state.elephaMcpCoverageFailure = 'missing-call-id';
            return undefined;
        }
        if (Buffer.byteLength(callId) > ELEPHA_MCP_CALL_ID_MAX_BYTES) {
            state.elephaMcpCoverageFailure = 'oversized-call-id';
            return undefined;
        }
        if (
            state.elephaMcpCallIds.has(callId) ||
            state.elephaMcpResultReceipts.some((receipt) => receipt.callId === callId) ||
            isTaskStateReportCallId(state, callId)
        ) {
            state.elephaMcpCoverageFailure = 'duplicate-call-id';
            return undefined;
        }
        if (state.elephaMcpUnmatchedResultIds.has(callId)) {
            state.elephaMcpCoverageFailure = 'out-of-order-result';
        } else if (state.elephaMcpUnmatchedCoverageIncomplete) {
            state.elephaMcpCoverageFailure = 'incomplete-correlation';
        }
        if (state.elephaMcpCallIds.size + state.elephaMcpResultReceipts.length >= ELEPHA_MCP_RESULTS_PER_TURN_MAX) {
            state.elephaMcpCoverageFailure = 'oversized-call-set';
            return undefined;
        }
        state.elephaMcpCallIds.add(callId);
        return callId;
    }

    private recordElephaMcpResult(state: TurnBuilderState, callId: unknown, value: unknown, timestamp: string | undefined): void {
        if (typeof callId === 'string' && Buffer.byteLength(callId) > ELEPHA_MCP_CALL_ID_MAX_BYTES) {
            if (state.elephaMcpCallIds.has(callId)) {
                state.elephaMcpCoverageFailure = 'oversized-call-id';
            }
            return;
        }
        if (typeof callId === 'string' && state.elephaMcpResultReceipts.some((receipt) => receipt.callId === callId)) {
            state.elephaMcpCoverageFailure = 'duplicate-call-id';
            return;
        }
        if (typeof callId !== 'string' || !state.elephaMcpCallIds.has(callId)) {
            if (typeof callId === 'string') {
                rememberUnmatchedElephaMcpResult(state, callId);
            }
            return;
        }
        const result = boundedMcpResult(value);
        if (result.state === 'incomplete') {
            state.elephaMcpCoverageFailure = result.reason;
            return;
        }
        state.elephaMcpCallIds.delete(callId);
        if (state.elephaMcpResultReceipts.length >= ELEPHA_MCP_RESULTS_PER_TURN_MAX) {
            state.elephaMcpCoverageFailure = 'oversized-result';
            return;
        }
        if (state.elephaMcpResultBytes + result.bytes > ELEPHA_MCP_RESULTS_PER_TURN_MAX_BYTES) {
            state.elephaMcpCoverageFailure = 'oversized-result';
            return;
        }
        // Structural order, not this diagnostic time, controls
        // eligibility. Prefer turn state so clock anomalies do not make
        // the diagnostic chronology misleading.
        const observedAt = canonicalTimestamp(state.endedAt, state.startedAt, timestamp) ?? null;
        state.elephaMcpResultBytes += result.bytes;
        state.elephaMcpResultReceipts.push({
            callId,
            body: result.body,
            observedAt,
        });
    }

    protected fold(state: TurnBuilderState, line: unknown): void {
        const l = line as CodexLine;
        const p = l.payload;
        if (!p) {
            return;
        }

        if (l.type === 'response_item' && p.type === 'message' && p.role === 'user') {
            for (const block of p.content ?? []) {
                if ((block.type === 'input_text' || block.type === 'text') && typeof block.text === 'string') {
                    state.userMessageParts.push(block.text);
                }
            }
            return;
        }

        if (l.type === 'event_msg' && p.type === 'user_message') {
            if (typeof p.message === 'string') {
                state.userMessageParts.push(p.message);
            }
            return;
        }

        if (l.type === 'response_item' && p.type === 'message' && p.role === 'assistant') {
            const firstPart = state.assistantTextParts.length;
            for (const block of p.content ?? []) {
                if ((block.type === 'output_text' || block.type === 'text') && typeof block.text === 'string') {
                    state.assistantTextParts.push(block.text);
                }
            }
            state.assistantMessageBoundaries.push({
                firstPart,
                partCount: state.assistantTextParts.length - firstPart,
                phase: p.phase === 'commentary' || p.phase === 'final_answer' ? p.phase : 'unclassified',
            });
            return;
        }

        if (l.type === 'response_item' && p.type === 'custom_tool_call') {
            // apply_patch: the standalone envelope. exec: a JS program that may
            // embed the same patch format - both are real file writes.
            const filePaths =
                p.name === 'apply_patch'
                    ? extractPatchFilePaths(p.input, state.projectPath)
                    : extractExecFilePaths(p.input, state.projectPath);
            const call: ParsedToolCall = { name: p.name ?? 'unknown', filePaths, text: p.input ?? '' };
            state.toolCalls.push(call);
            return;
        }

        // Parsed into the turn's separate report field, never ordinary capture.
        if (l.type === 'response_item' && isTaskStateReportFunctionCall(p)) {
            return;
        }

        if (l.type === 'response_item' && p.type === 'function_call') {
            // Two deterministic sources here: read_file's explicit file_path
            // argument, and a patch envelope embedded in an exec_command cmd
            // (arguments are JSON-encoded, so decode before scanning).
            const call: ParsedToolCall = {
                name: p.name ?? 'unknown',
                filePaths: [
                    ...extractReadFileePaths(p.name, p.arguments, state.projectPath),
                    ...extractExecFilePaths(decodeArguments(p.arguments), state.projectPath),
                ],
                text: p.arguments ?? '',
            };
            state.toolCalls.push(call);
        }
    }
}
