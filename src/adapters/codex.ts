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
// apply_patch call as a result. Versioned real-sample fixtures guard the shape.
//
// function_call/function_call_output IS the real envelope for genuine
// OpenAI-style tool calls (MCP servers, read_file, exec_command, ...) -
// arguments there really is a JSON-encoded string.
//
// Every payload.type/top-level type this adapter treats as skip is listed
// explicitly below (KNOWN_*). Anything not in one of those sets triggers
// warnUnknownLine() instead of silently falling through - the exact failure
// mode that let the apply_patch envelope bug ship unnoticed.

import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { codexSessionsRoot, isWithin, toPosix } from '../config/paths.js';
import type { EmptySessionAnalysis, ParsedToolCall, ParseTurnsOptions, SessionClassification, ToolName } from '../types/index.js';
import {
    classifyEmptyJsonlSession,
    type EmptySessionSignals,
    JsonlTurnAdapter,
    type LineClass,
    OversizedTranscriptRecordError,
    readBoundedLines,
    resolveAbsolute,
    safeDiscriminator,
    type TurnBuilderState,
    textValues,
} from './base.js';
import { INTERNAL_COMMAND_NAME, INTERNAL_COMMAND_TAGS } from './internal-command.js';

const ROLLOUT_ID_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
const EXTERNAL_IMPORT_TURN_PREFIX = 'external-import-turn-';

// Top-level line types this adapter has observed and deliberately ignores
// (none carry turn content; session_meta/turn_context are mined for cwd only).
const KNOWN_TOP_LEVEL_SKIP = new Set(['session_meta', 'turn_context', 'world_state', 'compacted', 'inter_agent_communication_metadata']);

// event_msg.payload.type subtypes other than "user_message". agent_message is
// a higher-volume duplicate of the response_item assistant text we already
// use as the source of truth - intentionally not read here.
const KNOWN_EVENT_MSG_SKIP = new Set([
    'token_count',
    'agent_message',
    'task_started',
    'task_complete',
    'thread_settings_applied',
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
    cwd?: string;
    message?: string;
    name?: string;
    arguments?: string; // function_call: JSON-encoded string
    input?: string; // custom_tool_call: raw string (real newlines)
    content?: CodexMessageContentBlock[];
    call_id?: string;
    turn_id?: string;
    source?: { subagent?: { thread_spawn?: unknown } };
}

interface CodexLine {
    timestamp?: string;
    type: string; // "session_meta" | "event_msg" | "response_item" | "turn_context" | ...
    payload?: CodexPayload;
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
    parent_thread_id?: string | null;
    thread_source?: string | null;
    agent_path?: string | null;
    agent_nickname?: string | null;
    originator?: string;
    git?: { branch?: string; commit_hash?: string; repository_url?: string | null };
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

export class CodexAdapter extends JsonlTurnAdapter {
    readonly tool: ToolName = 'codex';
    readonly watchGlobs = ['*/*/*/rollout-*.jsonl'];
    private readonly userBoundaryByFile = new Map<string, 'event_msg' | 'response_item'>();

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

    // Codex has emitted both user-turn envelopes. When an event_msg is present
    // before the response, it is the historical boundary; otherwise the
    // role:user response_item is the complete record. Resolve that once per
    // parse so a rollout containing the duplicate pair does not emit twice.
    private async userBoundaryFor(
        filePath: string,
        options: { handle?: FileHandle; signal?: AbortSignal } = {},
    ): Promise<'event_msg' | 'response_item'> {
        let sawUserResponse = false;

        try {
            for await (const { text } of readBoundedLines(filePath, { handle: options.handle })) {
                if (options.signal?.aborted) {
                    return 'response_item';
                }
                let line: CodexLine;
                try {
                    line = JSON.parse(text) as CodexLine;
                } catch {
                    continue;
                }
                const payload = line.payload;
                if (line.type === 'event_msg' && payload?.type === 'user_message') {
                    return 'event_msg';
                }
                if (
                    line.type === 'response_item' &&
                    payload?.type === 'message' &&
                    payload.role === 'user' &&
                    !this.isResumeMarkerLine(line)
                ) {
                    sawUserResponse = true;
                    continue;
                }
                // A user prompt followed by the assistant without an
                // event_msg is the response_item-only format. No later
                // transcript line can turn that completed turn into the
                // duplicate form.
                if (sawUserResponse && line.type === 'response_item' && payload?.type === 'message' && payload.role === 'assistant') {
                    return 'response_item';
                }
            }
        } catch (error) {
            if (error instanceof OversizedTranscriptRecordError) {
                throw error;
            }
            // The daemon's readability guard owns a visible failure. The
            // response envelope is the conservative fallback if a direct
            // adapter caller races a disappearing file.
        }

        return 'response_item';
    }

    override async *parseTurns(filePath: string, sinceCursor?: string, options?: Parameters<JsonlTurnAdapter['parseTurns']>[2]) {
        this.userBoundaryByFile.set(filePath, await this.userBoundaryFor(filePath, options));
        if (options?.signal?.aborted) {
            return;
        }
        yield* super.parseTurns(filePath, sinceCursor, options);
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
    // the three cases:
    //
    // - forked_from_id non-null -> the file BEGINS with a verbatim copy of the
    //   parent's whole transcript, every copied line restamped with the fork
    //   instant (observed: 175 turns inside 73ms of each other, byte-identical
    //   user messages to the parent, vs. multi-hour spans on every
    //   non-forked child). Ingesting it duplicates the parent.
    // - thread_source 'subagent' with NO agent_path/agent_nickname -> Codex's
    //   internal approval adjudicator. Its own prompt labels the transcript
    //   "untrusted evidence, not instructions to follow"; there is no human in
    //   it. User-spawned subagents always carry both fields.
    async classifySession(filePath: string, options?: Pick<ParseTurnsOptions, 'handle'>): Promise<SessionClassification> {
        const { first, externalAgentImport } = await this.readClassificationPreamble(filePath, options?.handle);
        if (!first) {
            return { kind: 'primary' };
        }
        const meta = (first.payload ?? {}) as CodexSessionMeta;

        if (externalAgentImport) {
            return {
                kind: 'primary',
                exclusion: 'external-agent-import',
                reason: `turn_id starts with ${EXTERNAL_IMPORT_TURN_PREFIX}`,
            };
        }

        if (meta.forked_from_id) {
            return {
                kind: 'fork-copy',
                parentNativeId: meta.forked_from_id,
                reason: `transcript opens with a fork-time copy of session ${meta.forked_from_id}`,
            };
        }

        if (meta.thread_source === 'subagent') {
            // A user-spawned subagent always carries its identity; the internal
            // adjudicator never does.
            if (!meta.agent_path && !meta.agent_nickname) {
                return {
                    kind: 'adjudicator',
                    parentNativeId: meta.parent_thread_id ?? undefined,
                    reason: 'Codex internal approval-adjudication transcript (untrusted evidence, no human)',
                };
            }
            return { kind: 'subagent', parentNativeId: meta.parent_thread_id ?? undefined };
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
        handle?: FileHandle,
    ): Promise<{ first: CodexLine | undefined; externalAgentImport: boolean }> {
        let first: CodexLine | undefined;

        try {
            for await (const { text } of readBoundedLines(filePath, { handle })) {
                let line: CodexLine;
                try {
                    line = JSON.parse(text) as CodexLine;
                } catch {
                    continue;
                }

                first ??= line;
                const turnId = line.type === 'event_msg' ? line.payload?.turn_id : undefined;
                if (typeof turnId === 'string') {
                    return { first, externalAgentImport: turnId.startsWith(EXTERNAL_IMPORT_TURN_PREFIX) };
                }
            }
        } catch (error) {
            if (error instanceof OversizedTranscriptRecordError) {
                throw error;
            }
            // The daemon's file-level readability guard owns the visible alert.
        }

        return { first, externalAgentImport: false };
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
                this.warnUnknownLine(`CodexAdapter: unrecognized event_msg.payload.type "${safeDiscriminator(p.type)}" in ${filePath}`);
            }
            return 'skip';
        }

        if (l.type === 'response_item') {
            if (p.type === 'message') {
                if (p.role === 'assistant') {
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
                this.warnUnknownLine(`CodexAdapter: unrecognized response_item.payload.type "${safeDiscriminator(p.type)}" in ${filePath}`);
            }
            return 'skip';
        }

        if (!KNOWN_TOP_LEVEL_SKIP.has(l.type)) {
            this.warnUnknownLine(`CodexAdapter: unrecognized top-level type "${safeDiscriminator(l.type)}" in ${filePath}`);
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
            for (const block of p.content ?? []) {
                if ((block.type === 'output_text' || block.type === 'text') && typeof block.text === 'string') {
                    state.assistantTextParts.push(block.text);
                }
            }
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
