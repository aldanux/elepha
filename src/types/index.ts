// Shared types: SessionTurn, ToolName, etc.

import type { FileHandle } from 'node:fs/promises';

export const TOOL_METADATA = {
    'claude-code': { displayName: 'Claude Code' },
    codex: { displayName: 'Codex' },
} as const;

export type ToolName = keyof typeof TOOL_METADATA;

export const SUPPORTED_TOOLS = Object.keys(TOOL_METADATA) as ToolName[];

export function isToolName(value: unknown): value is ToolName {
    return SUPPORTED_TOOLS.includes(value as ToolName);
}

export interface ParsedToolCall {
    /** Tool/function name as emitted by the source CLI, e.g. "Edit", "Write", "Bash", "exec_command", "apply_patch". */
    name: string;
    /** Absolute, canonical file paths touched by this call, where the adapter can identify them. */
    filePaths: string[];
    /** Original textual arguments, retained only while assembling a turn so Rule 4 can detect a sentinel rewrapped inside a tool call. */
    text?: string;
}

/**
 * One turn (a user request + the assistant's response, including any tool calls
 * in between) as extracted from a single session's JSONL file, normalized to a
 * tool-agnostic shape.
 */
export interface ParsedTurn {
    tool: ToolName;
    /** Native session/thread id as emitted by the source tool. */
    sessionId: string;
    /** Absolute path to the source JSONL file this turn came from. */
    sourcePath: string;
    /** Absolute, canonical cwd at turn time. Keys `projects`. */
    projectPath: string;
    /** 0-based position of this turn within the session, used for dedupe. */
    turnIndex: number;
    /** UTC ISO-8601 with trailing Z. */
    startedAt: string;
    /** UTC ISO-8601 with trailing Z. */
    endedAt: string;
    /** Plain-text user input for the turn. Meta/local-command wrapper lines filtered out. */
    userMessage: string;
    /** Claude Code's standalone ai-title event, associated only with the active turn. */
    aiTitle?: string;
    /** Plain-text assistant reply. Thinking blocks excluded. */
    assistantText: string;
    toolCalls: ParsedToolCall[];
    /** Opaque resume token marking the end of this turn in sourcePath. Stored as sessions.cursor. */
    cursor: string;
    /**
     * Raw surface discriminator as emitted by the tool (Claude Code:
     * `entrypoint`, e.g. "cli"/"claude-desktop"; Codex: `originator`, e.g.
     * "codex-tui"/"codex_exec"/"Codex Desktop"). Last-seen-wins across the
     * lines folded into this turn - see JsonlTurnAdapter.surfaceOf. Mapped to
     * the normalized 'cli'|'desktop' enum by src/adapters/discriminators.ts,
     * not here, so a raw value the mapping table doesn't yet recognize is
     * still visible for diagnosis instead of silently becoming undefined.
     */
    surface?: string;
    /**
     * Git branch at turn time. Per-turn and can drift within a Claude Code
     * session; session-constant for Codex (only session_meta.payload.git.branch
     * exists; no per-turn equivalent found in the full local corpus).
     * See JsonlTurnAdapter.branchOf.
     */
    gitBranch?: string;
    /**
     * True if this turn's raw lines included a tool-fetched-external-content
     * call (WebFetch/WebSearch on Claude Code, web_search_call on Codex).
     * Capture only; this flag records provenance without enforcing policy.
     * See JsonlTurnAdapter.isExternalFetchLine.
     */
    hasExternalContent: boolean;
    /**
     * True if a Codex `<environment_context>` resume marker (a synthetic
     * role:user response_item Codex injects on process (re)attachment) was seen immediately
     * before this turn's boundary line. Codex-only - Claude Code has per-turn
     * gitBranch and never overrides JsonlTurnAdapter.isResumeMarkerLine, so
     * this is always false there. It is boundary-evaluation evidence; the
     * marker line's own payload is never ingested (see
     * CodexAdapter.classify's existing role:user/developer skip).
     */
    resumeMarkerBefore: boolean;
    /** Present only for a complete turn the adapter withheld from persistence. */
    droppedReason?: 'sentinel';
}

export interface ParseTurnsOptions {
    /**
     * When true, a trailing buffered turn with no subsequent turn-boundary line
     * (i.e. still open at EOF) is treated as structurally complete and emitted.
     * Set by the daemon once a file has been idle past its debounce window.
     * When false (the default), a trailing open turn is never emitted — a
     * syntactically valid trailing JSON line is not proof the turn has ended.
     */
    closeTrailingOnIdle?: boolean;
    /** Reads from this already-opened file without taking ownership of the handle. */
    handle?: FileHandle;
    /** Stops a bounded read between transcript lines without changing cursor semantics. */
    signal?: AbortSignal;
}

/**
 * What kind of transcript a session file holds. Drives whether it is ingested
 * at all, and how it is presented.
 *
 * - 'primary'     - a real human-driven session. Ingest and list normally.
 * - 'subagent'    - genuine sub-agent doing real work on behalf of a parent
 *                   session. Ingest, but attach to the parent rather than
 *                   listing independently.
 * - 'fork-copy'   - the file opens with a verbatim copy of another session's
 *                   transcript, restamped with the fork time. Its content is
 *                   already ingested via the parent; ingesting it again is
 *                   duplication, not capture. Skip.
 * - 'adjudicator' - a tool-internal permission/approval ruling transcript with
 *                   no human in it. The source tool explicitly labels its
 *                   contents untrusted evidence, so summarizing it into served
 *                   memory is a prompt-injection path, not a feature. Skip.
 */
export type SessionKind = 'primary' | 'subagent' | 'fork-copy' | 'adjudicator';

/** File-level reason a transcript is deliberately excluded before turn parsing. */
export type SessionExclusion = 'external-agent-import';

/** Normalized session surface, after src/adapters/discriminators.ts maps the tool's raw field. */
export type SessionRowSurface = 'cli' | 'desktop';

/**
 * sessions.kind vocabulary. Deliberately NOT the same strings as
 * SessionKind ('primary'|'subagent'|'fork-copy'|'adjudicator') or
 * session_rollups.kind ('primary'|'subagent'). This vocabulary is mapped from
 * SessionKind by discriminators.ts's toSessionRowKind.
 * 'fork' and 'adjudicator' rows should never actually appear: both kinds are
 * skipped before a session row is ever created (see daemon/index.ts's
 * classification check) - the enum stays complete because the CHECK
 * constraint documents the full space, not because all four are reachable.
 */
export type SessionRowKind = 'main' | 'subagent' | 'fork' | 'adjudicator';

export interface SessionClassification {
    kind: SessionKind;
    /** A structurally identified transcript that must never enter the store. */
    exclusion?: SessionExclusion;
    /** Native session id of the owning session, for 'subagent' and 'fork-copy'. */
    parentNativeId?: string;
    /** Human-readable justification, logged when a session is skipped. */
    reason?: string;
}

export type EmptySessionKind = 'internal command' | 'no assistant contribution' | 'aborted prompt';

export interface EmptySessionAnalysis {
    kind: EmptySessionKind;
}

export interface SessionAdapter {
    readonly tool: ToolName;
    /** Glob pattern(s) this adapter watches, relative to the tool's home dir. */
    readonly watchGlobs: string[];
    /** True if this adapter owns the given absolute file path. */
    matches(filePath: string): boolean;
    /**
     * Classifies a session file before its turns are parsed, so non-ingestable
     * kinds cost nothing. Implementations must rely on structurally reliable
     * signals: on both tools the "obvious" per-line marker proved unreliable
     * (Codex's thread_source is set on genuine subagents too; Claude Code's
     * isSidechain/sessionId are absent on a quarter of lines).
     */
    classifySession(filePath: string, options?: Pick<ParseTurnsOptions, 'handle'>): Promise<SessionClassification>;
    /** Distinguishes known empty transcripts from a changed format that yielded no turns. */
    classifyEmptySession(filePath: string): Promise<EmptySessionAnalysis | undefined>;
    /**
     * Returns the user-set session title when the transcript format records
     * one. This is session metadata, not turn content: capture it separately
     * so a title event can never change rendered turn output.
     */
    readCustomTitle?(filePath: string, fromOffset?: number): Promise<{ customTitle?: string; scannedTo: number }>;
    /** Derives the native session/thread id from the file's own path, without reading it - lets callers look up a persisted cursor before the first turn is parsed. */
    nativeSessionId(filePath: string): string;
    /**
     * Parse turns from filePath, resuming after `sinceCursor` if given. Safe to
     * call repeatedly on a growing file (tail -f semantics). A turn is only
     * emitted once provably closed — see ParseTurnsOptions.closeTrailingOnIdle.
     * cursor advances once per emitted turn, never per parsed line.
     */
    parseTurns(filePath: string, sinceCursor?: string, options?: ParseTurnsOptions): AsyncIterable<ParsedTurn>;
}

/** Model-derived half of a memory record. files_touched is computed deterministically, not by the model. */
export interface SummarizationInput {
    userMessage: string;
    assistantText: string;
}

/**
 * 'ok' - model output parsed and validated.
 * 'parse_error' - API call(s) succeeded but no attempt produced schema-valid JSON.
 * 'api_error' - every attempt's API call itself failed (network, auth, 5xx, etc).
 * 'empty_turn' - input had no content to summarize; short-circuited, no API call made.
 * 'not_configured' - capture-only ingestion; no provider call was attempted.
 * A row's decisions/pending_items being empty is only "the AI had nothing to report"
 * when summarizer_status is 'ok' or 'empty_turn' - any other status means the empty
 * arrays are either intentionally unsynthesized ('not_configured') or a pipeline
 * failure. This keeps a pipeline failure distinguishable from a quiet session.
 */
export type SummarizerStatus = 'ok' | 'parse_error' | 'api_error' | 'empty_turn' | 'not_configured';

/**
 * One decision extracted from a single turn.
 *
 * `why` is nullable ON PURPOSE, and this is the point of capturing decisions
 * at turn level at all. Before this, turn rows stored bare strings and the
 * rationale was manufactured later by the rollup model, which never saw the
 * transcript - so a `why` always existed and was sometimes invented. Making it
 * nullable here means "the transcript gave no reason" is recorded as a fact
 * rather than papered over: the rollup can prefer decisions that carry a real
 * reason, and a null is visible instead of confabulated.
 *
 * Dropping reasonless decisions outright would discard a large share
 * of real choices that transcripts simply state without justifying.)
 */
export interface TurnDecision {
    what: string;
    why: string | null;
}

export interface SummarizationOutput {
    decisions: TurnDecision[];
    pending_items: string[];
    status: SummarizerStatus;
}

export interface SummarizationProvider {
    summarize(input: SummarizationInput): Promise<SummarizationOutput>;
}
