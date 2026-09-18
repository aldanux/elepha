// Adapter for ~/.claude/projects/<project-dir>/<session-uuid>.jsonl session files.
//
// Turn boundary = a real "user" line carrying human input (string content, or
// a content-block array with at least one non-tool_result block). Lines whose
// content is purely tool_result blocks are plumbing that echoes an assistant
// tool_use back into the loop - they carry no new information (the tool name
// + input we need is already on the preceding assistant tool_use block), so
// they're skipped rather than folded. Local-command wrapper lines
// (<local-command-caveat>, <command-name>, <local-command-stdout>, ...) and
// isMeta lines are bookkeeping and are skipped too, never open a turn.
//
// Every top-level line type this adapter treats as skip is listed explicitly
// in KNOWN_SKIP_TYPES (verified against real ~/.claude/projects transcripts).
// A type not in that set triggers warnUnknownLine() instead of silently
// falling through. This format is internal to Claude Code and can change
// between versions; a wrong or outdated assumption here should be
// loud, not quietly-empty data; an assumed Codex envelope once hid every
// apply_patch call.

import path from 'node:path';
import {
    ELEPHA_MCP_CALL_ID_MAX_BYTES,
    ELEPHA_MCP_NAMESPACE,
    ELEPHA_MCP_RESULTS_PER_TURN_MAX,
    ELEPHA_MCP_RESULTS_PER_TURN_MAX_BYTES,
} from '../config/constants.js';
import { claudeProjectsRoot, isWithin, toPosix } from '../config/paths.js';
import type { EmptySessionAnalysis, ParsedToolCall, SessionAdapterTool, SessionClassification } from '../types/index.js';
import {
    boundedMcpResult,
    canonicalTimestamp,
    classifyEmptyJsonlSession,
    type EmptySessionSignals,
    JsonlTurnAdapter,
    type LineClass,
    readBoundedLines,
    rememberUnmatchedElephaMcpResult,
    resolveAbsolute,
    safeDiscriminator,
    type TurnBuilderState,
    textValues,
} from './base.js';
import { INTERNAL_COMMAND_NAME, INTERNAL_COMMAND_TAGS } from './internal-command.js';

const COMMAND_WRAPPER_TAGS = ['<local-command-caveat>', '<command-name>', '<local-command-stdout>', '<command-args>'];

// Top-level types other than "user" and "assistant" seen in real transcripts,
// none of which carry turn content.
const KNOWN_SKIP_TYPES = new Set([
    'mode',
    'permission-mode',
    'attachment',
    'file-history-snapshot',
    'file-history-delta',
    'last-prompt',
    'system',
    'agent-name',
    'queue-operation',
    'pr-link',
    'fork-context-ref',
    // UI decoration: links an Artifact frame, carries no turn or session
    // memory. Explicit so format drift cannot hide behind generic skip.
    'frame-link',
    // UI decoration: internal latch marker, carries no turn content.
    'atis-latch',
    // Session usage snapshot: cumulative token/cost, timing, changed-line,
    // and per-model usage totals. It carries no turn content and must not be ingested.
    'cost-state',
    // Marks a bridged (Cowork/remote) session. Metadata only: bridge,
    // session, and owner ids plus a sequence number; it carries no turn
    // content and must not be ingested.
    'bridge-session',
    // Captured separately into sessions.custom_title; it must not become turn
    // content or influence any title-selection/rendering path yet.
    'custom-title',
]);

const EXTERNAL_FETCH_TOOLS = new Set(['WebFetch', 'WebSearch']);

const FILE_PATH_INPUT_KEY: Record<string, string> = {
    Edit: 'file_path',
    MultiEdit: 'file_path',
    Write: 'file_path',
    Read: 'file_path',
    NotebookEdit: 'notebook_path',
};

interface CCTextBlock {
    type: 'text';
    text: string;
}

interface CCThinkingBlock {
    type: 'thinking';
}

interface CCToolUseBlock {
    type: 'tool_use';
    id?: string;
    name: string;
    input: Record<string, unknown>;
}

interface CCToolResultBlock {
    type: 'tool_result';
    tool_use_id?: string;
    content?: unknown;
}

type CCContentBlock = CCTextBlock | CCThinkingBlock | CCToolUseBlock | CCToolResultBlock | { type: string };

interface CCLine {
    type: string;
    cwd?: string;
    timestamp?: string;
    isMeta?: boolean;
    entrypoint?: string;
    gitBranch?: string;
    customTitle?: string;
    aiTitle?: string;
    message?: {
        role: string;
        content: string | CCContentBlock[];
    };
}

function isWrapperText(text: string): boolean {
    const trimmed = text.trim();
    return COMMAND_WRAPPER_TAGS.some((tag) => trimmed.startsWith(tag));
}

function isPureToolResult(content: CCContentBlock[]): boolean {
    return content.length > 0 && content.every((b) => b.type === 'tool_result');
}

function emptySessionSignals(line: CCLine): EmptySessionSignals {
    const role = line.message?.role;
    const isUser = role === 'user';
    const values = textValues(line.message?.content);
    const content = line.message?.content;

    return {
        userContentSeen: isUser,
        internalCommand: isUser && values.some((value) => INTERNAL_COMMAND_NAME.test(value) && INTERNAL_COMMAND_TAGS.test(value)),
        nonInternalUserContent: isUser && values.some((value) => value.trim() !== '' && !INTERNAL_COMMAND_TAGS.test(value)),
        assistantContribution: role === 'assistant' || line.type === 'assistant',
        toolCall:
            Array.isArray(content) &&
            content.some((block) => block && typeof block === 'object' && (block as { type?: unknown }).type === 'tool_use'),
    };
}

function extractFilePaths(name: string, input: Record<string, unknown>, cwd: string | undefined): string[] {
    const key = FILE_PATH_INPUT_KEY[name];
    if (!key) {
        return [];
    }
    const raw = input[key];
    if (typeof raw !== 'string' || raw.length === 0) {
        return [];
    }

    return [resolveAbsolute(raw, cwd ?? process.cwd())];
}

export class ClaudeCodeAdapter extends JsonlTurnAdapter {
    readonly tool: SessionAdapterTool = 'claude-code';
    readonly watchGlobs = ['*/*.jsonl'];

    matches(filePath: string): boolean {
        return isWithin(claudeProjectsRoot(), filePath) && toPosix(filePath).endsWith('.jsonl');
    }

    nativeSessionId(filePath: string): string {
        return path.basename(filePath, '.jsonl');
    }

    // Claude Code writes custom-title as a standalone UI event. Last title
    // wins, matching the transcript's append-only state without treating the
    // event as a user/assistant turn or changing rendered output.
    async readCustomTitle(filePath: string, fromOffset = 0): Promise<{ customTitle?: string; scannedTo: number }> {
        let customTitle: string | undefined;
        let scannedTo = fromOffset;
        for await (const { text, byteLength, terminated } of readBoundedLines(filePath, { start: fromOffset })) {
            if (!terminated) {
                continue;
            }
            scannedTo += byteLength;
            try {
                const line = JSON.parse(text) as CCLine;
                if (line.type === 'custom-title' && typeof line.customTitle === 'string') {
                    customTitle = line.customTitle;
                }
            } catch {
                // parseTurns owns malformed-line handling and cursoring.
            }
        }
        return customTitle === undefined ? { scannedTo } : { customTitle, scannedTo };
    }

    // Sub-agent transcripts live at
    // `<projects>/<project-dir>/<parent-session-uuid>/subagents/agent-<hex>.jsonl`.
    //
    // The path is the marker, deliberately: the per-line fields that look
    // authoritative are not. Across the real corpus `isSidechain` and
    // `sessionId` are present on most lines but ABSENT on others within the
    // same file, so a first-line probe misclassifies ~25% of these files. The
    // directory layout was right for 16 of 16, and costs no read at all.
    async classifySession(filePath: string): Promise<SessionClassification> {
        const parts = toPosix(filePath).split('/');
        const subagentsAt = parts.lastIndexOf('subagents');
        if (subagentsAt > 0 && path.basename(filePath).startsWith('agent-')) {
            return { kind: 'subagent', parentNativeId: parts[subagentsAt - 1] };
        }
        return { kind: 'primary' };
    }

    async classifyEmptySession(filePath: string): Promise<EmptySessionAnalysis | undefined> {
        return classifyEmptyJsonlSession(filePath, (line) => emptySessionSignals(line as CCLine));
    }

    protected cwdOf(line: unknown): string | undefined {
        const l = line as CCLine;
        return typeof l.cwd === 'string' ? l.cwd : undefined;
    }

    protected timestampOf(line: unknown): string | undefined {
        const l = line as CCLine;
        return typeof l.timestamp === 'string' ? l.timestamp : undefined;
    }

    protected surfaceOf(line: unknown): string | undefined {
        const l = line as CCLine;
        return typeof l.entrypoint === 'string' ? l.entrypoint : undefined;
    }

    protected branchOf(line: unknown): string | undefined {
        const l = line as CCLine;
        return typeof l.gitBranch === 'string' ? l.gitBranch : undefined;
    }

    protected aiTitleOf(line: unknown): string | undefined {
        const l = line as CCLine;
        return l.type === 'ai-title' && typeof l.aiTitle === 'string' && l.aiTitle.trim() !== '' ? l.aiTitle : undefined;
    }

    protected isExternalFetchLine(line: unknown): boolean {
        const l = line as CCLine;
        if (l.type !== 'assistant') {
            return false;
        }
        const content = l.message?.content;
        if (!Array.isArray(content)) {
            return false;
        }
        return content.some((b) => b.type === 'tool_use' && EXTERNAL_FETCH_TOOLS.has((b as CCToolUseBlock).name));
    }

    protected classify(line: unknown, filePath: string): LineClass {
        const l = line as CCLine;
        if (l.type === 'user') {
            if (l.isMeta) {
                return 'skip';
            }
            const content = l.message?.content;
            if (typeof content === 'string') {
                return isWrapperText(content) ? 'skip' : 'boundary';
            }
            if (Array.isArray(content)) {
                return isPureToolResult(content) ? 'skip' : 'boundary';
            }
            return 'skip';
        }

        if (l.type === 'assistant') {
            return 'content';
        }

        if (l.type === 'ai-title') {
            return 'skip';
        }

        if (!KNOWN_SKIP_TYPES.has(l.type)) {
            this.warnUnknownLine(`ClaudeCodeAdapter: unrecognized line type "${safeDiscriminator(l.type)}" in ${filePath}`);
        }
        return 'skip';
    }

    protected observeToolCallState(state: TurnBuilderState, line: unknown): void {
        const content = (line as CCLine).message?.content;
        if (!Array.isArray(content)) {
            return;
        }
        for (const block of content) {
            if (block.type === 'tool_use') {
                const id = (block as CCToolUseBlock).id;
                if (typeof id === 'string') {
                    state.openToolCallIds.add(id);
                }
            } else if (block.type === 'tool_result') {
                const id = (block as CCToolResultBlock).tool_use_id;
                if (typeof id === 'string') {
                    state.openToolCallIds.delete(id);
                }
            }
        }
    }

    protected observeElephaMcp(state: TurnBuilderState, line: unknown): void {
        const l = line as CCLine;
        const content = l.message?.content;
        if (!Array.isArray(content)) {
            return;
        }
        for (const block of content) {
            if (block.type === 'tool_use') {
                const call = block as CCToolUseBlock;
                if (!call.name.startsWith(`${ELEPHA_MCP_NAMESPACE}__`)) {
                    continue;
                }
                if (typeof call.id !== 'string' || call.id === '') {
                    state.elephaMcpCoverageFailure = 'missing-call-id';
                    continue;
                }
                if (Buffer.byteLength(call.id) > ELEPHA_MCP_CALL_ID_MAX_BYTES) {
                    state.elephaMcpCoverageFailure = 'oversized-call-id';
                    continue;
                }
                if (state.elephaMcpCallIds.has(call.id) || state.elephaMcpResultReceipts.some((receipt) => receipt.callId === call.id)) {
                    state.elephaMcpCoverageFailure = 'duplicate-call-id';
                    continue;
                }
                if (state.elephaMcpUnmatchedResultIds.has(call.id)) {
                    state.elephaMcpCoverageFailure = 'out-of-order-result';
                } else if (state.elephaMcpUnmatchedCoverageIncomplete) {
                    state.elephaMcpCoverageFailure = 'incomplete-correlation';
                }
                if (state.elephaMcpCallIds.size + state.elephaMcpResultReceipts.length >= ELEPHA_MCP_RESULTS_PER_TURN_MAX) {
                    state.elephaMcpCoverageFailure = 'oversized-call-set';
                    continue;
                }
                state.elephaMcpCallIds.add(call.id);
                continue;
            }
            if (block.type !== 'tool_result') {
                continue;
            }
            const resultBlock = block as CCToolResultBlock;
            const callId = resultBlock.tool_use_id;
            if (typeof callId === 'string' && Buffer.byteLength(callId) > ELEPHA_MCP_CALL_ID_MAX_BYTES) {
                if (state.elephaMcpCallIds.has(callId)) {
                    state.elephaMcpCoverageFailure = 'oversized-call-id';
                }
                continue;
            }
            if (typeof callId === 'string' && state.elephaMcpResultReceipts.some((receipt) => receipt.callId === callId)) {
                state.elephaMcpCoverageFailure = 'duplicate-call-id';
                continue;
            }
            if (typeof callId !== 'string' || !state.elephaMcpCallIds.has(callId)) {
                if (typeof callId === 'string') {
                    rememberUnmatchedElephaMcpResult(state, callId);
                }
                continue;
            }
            const result = boundedMcpResult(resultBlock.content);
            if (result.state === 'incomplete') {
                state.elephaMcpCoverageFailure = result.reason;
                continue;
            }
            state.elephaMcpCallIds.delete(callId);
            if (state.elephaMcpResultReceipts.length >= ELEPHA_MCP_RESULTS_PER_TURN_MAX) {
                state.elephaMcpCoverageFailure = 'oversized-result';
                continue;
            }
            if (state.elephaMcpResultBytes + result.bytes > ELEPHA_MCP_RESULTS_PER_TURN_MAX_BYTES) {
                state.elephaMcpCoverageFailure = 'oversized-result';
                continue;
            }
            // Structural order, not this diagnostic time, controls
            // eligibility. Prefer turn state so clock anomalies do not
            // make the diagnostic chronology misleading.
            const observedAt = canonicalTimestamp(state.endedAt, state.startedAt, l.timestamp) ?? null;
            state.elephaMcpResultBytes += result.bytes;
            state.elephaMcpResultReceipts.push({
                callId,
                body: result.body,
                observedAt,
            });
        }
    }

    protected fold(state: TurnBuilderState, line: unknown): void {
        const l = line as CCLine;
        const content = l.message?.content;
        if (!content) {
            return;
        }

        if (l.type === 'user') {
            if (typeof content === 'string') {
                state.userMessageParts.push(content);
            } else {
                for (const block of content) {
                    if (block.type === 'text') {
                        state.userMessageParts.push((block as CCTextBlock).text);
                    }
                }
            }
            return;
        }

        if (l.type === 'assistant' && Array.isArray(content)) {
            for (const block of content) {
                if (block.type === 'text') {
                    state.assistantTextParts.push((block as CCTextBlock).text);
                } else if (block.type === 'tool_use') {
                    const tb = block as CCToolUseBlock;
                    const call: ParsedToolCall = {
                        name: tb.name,
                        filePaths: extractFilePaths(tb.name, tb.input ?? {}, state.projectPath),
                        text: JSON.stringify(tb.input ?? {}),
                    };
                    state.toolCalls.push(call);
                }
            }
        }
    }
}
