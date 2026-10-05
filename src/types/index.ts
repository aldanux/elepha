import type { FileHandle } from 'node:fs/promises';
import type Database from 'better-sqlite3-multiple-ciphers';
import type { TASK_STATE_REPORT_MODES } from '../config/constants.js';
import type { AssistantStructure } from '../rendering/assistant-structure.js';

export const TOOL_METADATA = {
    'claude-code': { displayName: 'Claude Code' },
    codex: { displayName: 'Codex' },
    opencode: { displayName: 'OpenCode' },
} as const;

export type ToolName = keyof typeof TOOL_METADATA;
export type SessionAdapterTool = Exclude<ToolName, 'opencode'>;

export const SUPPORTED_TOOLS = Object.keys(TOOL_METADATA) as ToolName[];
export const SESSION_ADAPTER_TOOLS = ['claude-code', 'codex'] as const satisfies readonly SessionAdapterTool[];

export function isToolName(value: unknown): value is ToolName {
    return SUPPORTED_TOOLS.includes(value as ToolName);
}

export interface ParsedToolCall {
    // Tool/function name as emitted by the source CLI, e.g. "Edit", "Write", "Bash", "exec_command", "apply_patch".
    name: string;
    // Absolute, canonical file paths touched by this call, where the adapter can identify them.
    filePaths: string[];
    // Original arguments, retained only during assembly so Rule 4 can detect a
    // sentinel rewrapped inside a tool call.
    text?: string;
}

export interface ElephaMcpResultReceipt {
    callId: string;
    body: string;
    observedAt: string | null;
}

export type TaskStateReportMode = (typeof TASK_STATE_REPORT_MODES)[number];

export interface TaskStateReportSource {
    role: 'user' | 'assistant';
    quote: string;
}

export interface TaskStateReportPrecompactItem {
    text: string;
    sources: TaskStateReportSource[];
}

export interface TaskStateReportPostcompactItem {
    text: string;
    sources?: never;
}

export type TaskStateReportItem = TaskStateReportPrecompactItem | TaskStateReportPostcompactItem;

// Validated report_task_state input exactly as the working AI submitted it.
export type TaskStateReportInput =
    | {
          mode: 'precompact_manifest';
          request_id: string;
          objective: TaskStateReportPrecompactItem | null;
          decisions: TaskStateReportPrecompactItem[];
          constraints: TaskStateReportPrecompactItem[];
          pending_items: TaskStateReportPrecompactItem[];
      }
    | {
          mode: 'postcompact_retained';
          request_id: string;
          objective: TaskStateReportPostcompactItem | null;
          decisions: TaskStateReportPostcompactItem[];
          constraints: TaskStateReportPostcompactItem[];
          pending_items: TaskStateReportPostcompactItem[];
      };

export type TaskStateReport = TaskStateReportInput & { callId: string };

// Why a report call observed in a turn yielded no report. The turn keeps its
// ordinary content; only the report is withheld.
export type TaskStateReportFailureReason =
    | 'non-root-session'
    | 'missing-call-id'
    | 'oversized-call-id'
    | 'duplicate-call-id'
    | 'malformed-input'
    | 'oversized-input'
    | 'multiple-reports'
    | 'conflicting-duplicate'
    | 'missing-result'
    | 'unexpected-result';

export type OpenTailReceiptCoverage = { state: 'complete'; turn: ParsedTurn } | { state: 'incomplete'; reason: string; turn: ParsedTurn };

// A terminal provider failure at EOF is observable but is not a completed
// conversational turn. The daemon may stage this candidate after its cost
// grace, while the canonical cursor remains anchored before the turn so a
// later retry, user boundary, success, or abort reparses and closes it once.
export interface OpenTailObservation {
    kind: 'failed-eof';
    anchorCursor?: string;
    candidateCursor: string;
    failedAt: string;
    receiptCoverage: OpenTailReceiptCoverage;
}

// One turn (a user request + the assistant's response, including any tool calls
// in between) as extracted from a single session's JSONL file, normalized to a
// tool-agnostic shape.
export interface ParsedTurn {
    tool: ToolName;
    sessionId: string;
    // Absolute path to the provider transcript source this turn came from.
    sourcePath: string;
    // Provider-owned project binding for the turn. Keys `projects`.
    projectPath: string;
    // 0-based position of this turn within the session, used for dedupe.
    turnIndex: number;
    startedAt: string;
    endedAt: string;
    // Plain-text user input for the turn. Meta/local-command wrapper lines filtered out.
    userMessage: string;
    // Claude Code's standalone ai-title event, associated only with the active turn.
    aiTitle?: string;
    // Plain-text assistant reply. Thinking blocks excluded.
    assistantText: string;
    assistantStructure?: AssistantStructure;
    // Adapter-derived provisional EOF closure; never part of source identity.
    provisionalIdle?: true;
    toolCalls: ParsedToolCall[];
    // Opaque resume token marking the end of this turn in sourcePath. Stored as sessions.cursor.
    cursor: string;
    // What a parse resuming at `cursor` needs to reconstruct the same turns.
    // Present only when it was read from the source; persisted with the cursor.
    resumeContext?: ResumeContext;
    // Raw surface discriminator as emitted by the tool (Claude Code:
    // `entrypoint`, e.g. "cli"/"claude-desktop"; Codex: `originator`, e.g.
    // "codex-tui"/"codex_exec"/"Codex Desktop"). Last-seen-wins across the
    // lines folded into this turn. The adapter mapping normalizes it to
    // 'cli'|'desktop' later, so an unrecognized raw value remains visible for
    // diagnosis instead of silently becoming undefined.
    surface?: string;
    // Git branch at turn time. Per-turn and can drift within a Claude Code
    // session; session-constant for Codex (only session_meta.payload.git.branch
    // exists; no per-turn equivalent found in the full local corpus).
    gitBranch?: string;
    // True if this turn's raw lines included a tool-fetched-external-content
    // call (WebFetch/WebSearch on Claude Code, web_search_call on Codex).
    // Capture only; this flag records provenance without enforcing policy.
    hasExternalContent: boolean;
    // True if a Codex `<environment_context>` resume marker (a synthetic
    // role:user response_item Codex injects on process (re)attachment) was seen immediately
    // before this turn's boundary line. Codex-only - Claude Code has per-turn
    // gitBranch and never overrides JsonlTurnAdapter.isResumeMarkerLine, so
    // this is always false there. It is boundary-evaluation evidence; the
    // marker line's own payload is classified as skipped plumbing and never ingested.
    resumeMarkerBefore: boolean;
    // Present only for a complete turn the adapter withheld from persistence.
    droppedReason?: 'sentinel' | 'report-input-unscanned' | 'empty' | 'elepha-mcp' | 'opencode-v2-elepha-mcp';
    // Private ingestion evidence. It is consumed transactionally with a
    // dropped cursor and must never enter memories, rendering, or exports.
    elephaMcpResultReceipts?: ElephaMcpResultReceipt[];
    // A verified report_task_state call from this turn. Kept out of toolCalls
    // so it never enters ordinary capture; Rule 4 checks still cover its text.
    // Parse-time evidence only: nothing persists it yet.
    taskStateReport?: TaskStateReport;
    // Present instead of taskStateReport when a report call could not be verified.
    taskStateReportFailure?: TaskStateReportFailureReason;
    sourceKey?: string;
    provenance?: { protocolVersion: string; producerVersion: string; modelAliases: string[] };
    // Validated synchronously again inside the ingestion transaction.
    validateSource?: () => boolean;
}

// One complete source record, newline included, whose content sets a parser
// context field. The digest covers the record text, so a resumed parse can
// prove the record still says what it said when the cursor was issued.
export interface SourceContextRecord {
    field: 'cwd' | 'surface' | 'branch';
    offset: number;
    length: number;
    digest: string;
}

export interface ResumeContext {
    // Records that set the working directory, surface and branch in effect at
    // the cursor. A resumed parse re-reads and verifies each one.
    records: readonly SourceContextRecord[];
    // Adapter decisions made from records before the cursor, such as which
    // Codex record type opens a turn. Like the cursor's own position and turn
    // index, they hold only while the cursor still authenticates.
    decisions?: Readonly<Record<string, string>>;
}

// A shared allowance of source bytes. Every read a parse makes, including
// cursor and context authentication, is charged against it before it happens.
export interface SourceReadBudget {
    remaining: number;
}

// Progress of reconstructing the resume context for a cursor issued without
// one. Opaque to callers; the adapter re-authenticates it before continuing.
export interface ResumeContextDerivation {
    endOffset: number;
    offset: number;
    fingerprint: string;
    records: SourceContextRecord[];
    decisionState: unknown;
}

export type ResumeContextDerivationResult =
    | { state: 'complete'; context: ResumeContext }
    | { state: 'partial'; progress: ResumeContextDerivation };

export interface ParseTurnsOptions {
    // When true, a trailing buffered turn with no subsequent turn-boundary line
    // (i.e. still open at EOF) is treated as structurally complete and emitted.
    // Set by the daemon once a file has been idle past its debounce window.
    // When false (the default), a trailing open turn is never emitted — a
    // syntactically valid trailing JSON line is not proof the turn has ended.
    closeTrailingOnIdle?: boolean;
    // Reads from this already-opened file without taking ownership of the handle.
    handle?: FileHandle;
    // The resumeContext issued with `sinceCursor`. Each record is re-read and
    // verified against the opened source before the parse resumes; a record
    // that no longer matches refuses the read like any other cursor desync.
    // Required to resume an adapter whose context carries across turns.
    resumeContext?: ResumeContext;
    // Called when the parse refuses to resume because the source no longer
    // matches the cursor or its context, as distinct from having nothing new.
    onDesync?: () => void;
    // Shared byte allowance; takes precedence over maxReadBytes. The caller
    // sees exactly what the parse consumed.
    readBudget?: SourceReadBudget;
    // Stops a bounded read between transcript lines without changing cursor semantics.
    signal?: AbortSignal;
    // Serving can stop before assembling an oversized historical interaction.
    // Bounds every source read the parse makes, not only the resumed tail.
    maxReadBytes?: number;
    // Replay an authenticated historical prefix using the opened source handle.
    endByteOffset?: number;
    // Receives a failed lifecycle held open at EOF. It is deliberately not an
    // item in the ParsedTurn iterator: canonical consumers see final turns only.
    onOpenTail?: (observation: OpenTailObservation) => void;
    // Receives how many complete (newline-terminated) records failed to parse
    // as JSON and were skipped. Called once per parse, only when non-zero, so
    // a caller can report lost records without reading the human-facing log.
    onMalformedRecords?: (count: number) => void;
    // Receives how many complete records had a shape the adapter does not
    // recognize and therefore skipped. Called once per parse, only when
    // non-zero. Known host records an adapter deliberately ignores are not
    // counted: they are not lost content.
    onUnrecognizedRecords?: (count: number) => void;
}

// What kind of transcript a session file holds. Drives whether it is ingested
// at all, and how it is presented.
//
// - 'primary'     - a real human-driven session. Ingest and list normally.
// - 'subagent'    - genuine sub-agent doing real work on behalf of a parent
//                  session. Ingest, but attach to the parent rather than
//                  listing independently.
// - 'fork-copy'   - the file opens with a verbatim copy of another session's
//                  transcript, restamped with the fork time. Its content is
//                  already ingested via the parent; ingesting it again is
//                  duplication, not capture. Skip.
// - 'adjudicator' - a tool-internal permission/approval ruling transcript with
//                  no human in it. The source tool explicitly labels its
//                  contents untrusted evidence, so summarizing it into served
//                  memory is a prompt-injection path, not a feature. Skip.
export type SessionKind = 'primary' | 'subagent' | 'fork-copy' | 'adjudicator';

// File-level reason a transcript is deliberately excluded before turn parsing.
export type SessionExclusion = 'external-agent-import';

// Normalized session surface derived from each tool's raw field.
export type SessionRowSurface = 'cli' | 'desktop';

// sessions.kind vocabulary. Deliberately NOT the same strings as
// SessionKind ('primary'|'subagent'|'fork-copy'|'adjudicator') or
// session_rollups.kind ('primary'|'subagent'). This vocabulary is mapped from
// SessionKind by discriminators.ts's toSessionRowKind.
// 'fork' and 'adjudicator' rows should never actually appear: both kinds are
// skipped before a session row is ever created. The enum stays complete because
// the CHECK constraint documents the full space, not because all four are reachable.
export type SessionRowKind = 'main' | 'subagent' | 'fork' | 'adjudicator';

export interface SessionClassification {
    kind: SessionKind;
    // A structurally identified transcript that must never enter the store.
    exclusion?: SessionExclusion;
    // Native session id of the owning session, for 'subagent' and 'fork-copy'.
    parentNativeId?: string;
    // Human-readable justification, logged when a session is skipped.
    reason?: string;
}

export type EmptySessionKind = 'internal command' | 'no assistant contribution' | 'aborted prompt';

export interface EmptySessionAnalysis {
    kind: EmptySessionKind;
}

export interface SessionAdapter {
    readonly tool: SessionAdapterTool;
    // Glob pattern(s) this adapter watches, relative to the tool's home dir.
    readonly watchGlobs: string[];
    // Reconcile current logical history before advancing this source. Pi can share this boundary.
    readonly retractable?: boolean;
    needsReconciliation?(filePath: string, cursor: string | undefined, handle: FileHandle): Promise<boolean>;
    readSourceMetadata?(filePath: string): Promise<
        | {
              cwd: string;
              timestamp: string;
              title?: string;
              customTitle?: string;
              validate: () => boolean;
          }
        | undefined
    >;
    eventSourcePath?(filePath: string): string | undefined;
    // True if this adapter owns the given absolute file path.
    matches(filePath: string): boolean;
    // Classifies a session file before its turns are parsed, so non-ingestable
    // kinds cost nothing. Implementations must rely on structurally reliable
    // signals: on both tools the "obvious" per-line marker proved unreliable
    // (Codex's thread_source is set on genuine subagents too; Claude Code's
    // isSidechain/sessionId are absent on a quarter of lines).
    classifySession(filePath: string, options?: Pick<ParseTurnsOptions, 'handle'>): Promise<SessionClassification>;
    // Distinguishes known empty transcripts from a changed format that yielded no turns.
    classifyEmptySession(filePath: string): Promise<EmptySessionAnalysis | undefined>;
    // Returns the user-set session title when the transcript format records
    // one. This is session metadata, not turn content: capture it separately
    // so a title event can never change rendered turn output.
    readCustomTitle?(filePath: string, fromOffset?: number): Promise<{ customTitle?: string; scannedTo: number }>;
    // Derives the native id from the path without reading the file, allowing a
    // persisted cursor lookup before the first parsed turn.
    nativeSessionId(filePath: string): string;
    // Parse turns from filePath, resuming after `sinceCursor` if given. Safe to
    // call repeatedly on a growing file (tail -f semantics). A turn is only
    // emitted once provably closed.
    // cursor advances once per emitted turn, never per parsed line.
    parseTurns(filePath: string, sinceCursor?: string, options?: ParseTurnsOptions): AsyncIterable<ParsedTurn>;
    // Where a cursor this adapter issued resumes: its source position and the
    // index of the next turn. Reads nothing.
    cursorPosition?(cursor: string): SourceCursorPosition;
    // The same position, but only while the opened source still holds the
    // bytes that were read when the cursor was issued; undefined once the
    // source was truncated or rewritten before it.
    authenticateCursor?(cursor: string, handle: FileHandle, readBudget?: SourceReadBudget): Promise<SourceCursorPosition | undefined>;
    // True when a turn's working directory or provenance can come from
    // records before its boundary, so resuming at a cursor needs that cursor's
    // resumeContext to reconstruct the same turn.
    readonly carriesContextAcrossTurns?: boolean;
    // Whether a stored context holds everything a resumed parse needs, so it
    // need not be reconstructed.
    resumeContextComplete?(context: ResumeContext): boolean;
    // Whether every context record still matches the opened source and lies
    // before `beforeOffset`.
    authenticateResumeContext?(
        context: ResumeContext,
        handle: FileHandle,
        beforeOffset: number,
        readBudget?: SourceReadBudget,
    ): Promise<boolean>;
    // One bounded, cancellable step of reconstructing the resume context for
    // a cursor at `endOffset`, continuing from earlier progress when that
    // progress still authenticates. Reads only before `endOffset`.
    deriveResumeContext?(
        handle: FileHandle,
        endOffset: number,
        options: { from?: ResumeContextDerivation; readBudget: SourceReadBudget; signal?: AbortSignal },
    ): Promise<ResumeContextDerivationResult>;
}

export interface SourceCursorPosition {
    byteOffset: number;
    nextTurnIndex: number;
}

export type SessionAdapterMap = Record<SessionAdapterTool, SessionAdapter>;

export interface OpenedSessionRow {
    sessionId: string;
    directory: string;
    title?: string;
    version?: string;
    parentId?: string;
    timeUpdated: number;
}

export interface SqliteSourceAdapter {
    readonly tool: ToolName;
    dirtySessions(db: Database.Database, sinceWatermark?: number): OpenedSessionRow[];
    parseSessionTurns(
        db: Database.Database,
        session: OpenedSessionRow,
        sinceCursor?: string,
        options?: Pick<ParseTurnsOptions, 'closeTrailingOnIdle'>,
    ): AsyncIterable<ParsedTurn> | Iterable<ParsedTurn>;
    classifySession(session: OpenedSessionRow): SessionClassification;
}

// Model-derived half of a memory record. files_touched is computed deterministically, not by the model.
export interface SummarizationInput {
    userMessage: string;
    assistantText: string;
}

// 'ok' - model output parsed and validated.
// 'parse_error' - API call(s) succeeded but no attempt produced schema-valid JSON.
// 'api_error' - every attempt's API call itself failed (network, auth, 5xx, etc).
// 'empty_turn' - input had no content to summarize; short-circuited, no API call made.
// 'not_configured' - capture-only ingestion; no provider call was attempted.
// A row's decisions/pending_items being empty is only "the AI had nothing to report"
// when summarizer_status is 'ok' or 'empty_turn' - any other status means the empty
// arrays are either intentionally unsynthesized ('not_configured') or a pipeline
// failure. This keeps a pipeline failure distinguishable from a quiet session.
export type SummarizerStatus = 'ok' | 'parse_error' | 'api_error' | 'empty_turn' | 'not_configured';

// One decision extracted from a single turn.
//
// `why` is nullable ON PURPOSE, and this is the point of capturing decisions
// at turn level at all. Before this, turn rows stored bare strings and the
// rationale was manufactured later by the rollup model, which never saw the
// transcript - so a `why` always existed and was sometimes invented. Making it
// nullable here means "the transcript gave no reason" is recorded as a fact
// rather than papered over: the rollup can prefer decisions that carry a real
// reason, and a null is visible instead of confabulated.
//
// Dropping reasonless decisions outright would discard a large share
// of real choices that transcripts simply state without justifying.)
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
