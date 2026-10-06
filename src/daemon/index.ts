// Ingestion daemon: watches Claude Code / Codex session paths, feeds new turns
// through adapters and writes structural capture into storage. Provider-backed
// extraction and rollups are optional work layered on top.
//
// Every file change triggers two kinds of scan:
// - a prompt scan (closeTrailingOnIdle: false) - picks up any turn that
//   already closed via a following boundary line, without waiting;
// - a debounced idle scan (closeTrailingOnIdle: true), fired once the file
//   has gone quiet for idleDebounceMs - flushes a trailing turn that never
//   got a following boundary line (e.g. the session is still open).
// Both go through a bounded concurrency queue: cost per summarization call is
// negligible, but several projects writing at once are not, and without a
// per-file mutex a second scan could re-read a cursor the first is still
// advancing.

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { stat as fsStat, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { setImmediate as yieldImmediate } from 'node:timers/promises';
import chokidar, { type FSWatcher } from 'chokidar';
import { OversizedTranscriptRecordError } from '../adapters/base.js';
import { ClaudeCodeAdapter } from '../adapters/claude-code.js';
import { CodexAdapter } from '../adapters/codex.js';
import { sessionSurface, toSessionRowKind } from '../adapters/discriminators.js';
import {
    OpencodeAdapter,
    type OpencodeV2HandoffBoundary,
    type OpencodeV2OverlapSession,
    type OpencodeV2ParseProgress,
    opencodeSessionAiTitle,
    opencodeV2OverlapKey,
    opencodeV2WatermarkKey,
    openOpencodeDbReadonly,
} from '../adapters/opencode.js';
import {
    DAEMON_MISSING_PACKAGE_CHECK_LIMIT,
    DAEMON_PACKAGE_REPLACED_EXIT_CODE,
    DEFAULT_IDLE_DEBOUNCE_MS,
    DEFAULT_MAX_CONCURRENT,
    EMBEDDING_REFRESH_INTERVAL_MS,
    FIRST_PROMPT_SEARCH_BACKFILL_BATCH_SIZE,
    HEARTBEAT_INTERVAL_MS,
    MAX_DAEMON_UNKNOWN_LINE_WARNINGS,
    OPEN_TURN_SUMMARY_GRACE_MS,
    OPENCODE_V2_OVERLAP_PAGE_SIZE,
    OPENCODE_V2_PENDING_SCAN_LIMIT,
    PACKAGE_VERSION,
    readInstalledPackageVersion,
    SWEEP_INTERVAL_MS,
    UPDATE_CHECK_LOOP_INTERVAL_MS,
} from '../config/constants.js';
import { retainsFilteredCopy } from '../config/filtered-capture-policy.js';
import { readMemoryConfig } from '../config/memory-config.js';
import {
    canonicalizeExisting,
    claudeProjectsRoot,
    codexSessionsRoot,
    daemonStderrLogPath,
    daemonStdoutLogPath,
    isReadableProviderSource,
    isWithin,
    opencodeDbPath,
    opencodeStoreRoot,
    samePath,
    updateAvailablePath,
    updateCheckStatePath,
} from '../config/paths.js';

import { RESUME_CONTEXT_STEP_BYTES, RESUME_CONTEXT_STEP_MS } from '../config/resume-context.js';
import { getSetting } from '../config/settings.js';
import { readSessionMetadata } from '../discovery/session-projects.js';
import { type EmbeddingRefresh, startEmbeddingRefresh } from '../embeddings/refresh.js';
import { installedAndLatestElephaVersionAsync } from '../install/self-update.js';
import { filterTurn } from '../rendering/filtered-turn.js';
import { openProviderTranscript, type ProviderTranscriptOpener } from '../security/provider-transcript.js';
import type { ConsentState } from '../storage/consent-store.js';
import { DurableCaptureStore } from '../storage/durable-capture-store.js';
import { applyFirstPromptSearchBackfill } from '../storage/first-prompt-search-backfill.js';
import { isLiveMemoryCapacityGuardError, LiveMemoryCapacityError } from '../storage/live-memory-capacity-guard.js';
import { LiveMemoryCaptureDeferredError, LiveMemoryRetentionVerificationError } from '../storage/live-memory-retention.js';
import type { MemoryStore } from '../storage/memory-store.js';
import type { OpenTurnSourceSnapshot } from '../storage/open-turn-store.js';
import { isMemoryLocked } from '../storage/paranoid-gate.js';

import { ProjectResolver } from '../storage/project-resolver.js';
import type { RollupStore } from '../storage/rollup-store.js';
import { evaluateSegmentBoundary } from '../storage/segmentation.js';
import {
    type KindReconciliationContinuation,
    reconcileSessionKinds,
    settleSessionKindReconciliation,
} from '../storage/session-kind-reconciliation.js';
import { isSessionKindEligible, SERVED_SESSION_KIND_ELIGIBILITY } from '../storage/session-read-model.js';
import { SourceReconciliation, sourceGeneration, sourceSnapshotValidator } from '../storage/source-reconciliation.js';
import type {
    EmptySessionKind,
    OpenTailObservation,
    ParsedTurn,
    ResumeContext,
    ResumeContextDerivationResult,
    SessionAdapter,
    SessionAdapterMap,
    SessionClassification,
    SqliteSourceAdapter,
    SummarizationProvider,
    SummarizerStatus,
    ToolName,
} from '../types/index.js';
import { errorMessage } from '../util/error.js';
import { FailureWindow } from './failure-window.js';
import { clearHeartbeat, defaultHeartbeatPath, writeHeartbeat } from './heartbeat.js';
import { type DaemonLogPaths, rotateDaemonLogs } from './log-rotation.js';
import { type FileSkip, type FileSkipCategory, ReadabilityGuard } from './readability-guard.js';
import type { RollupService } from './rollup-service.js';
import { TaskStateManifestPublisher, type TaskStateManifestRecoveryBudget } from './task-state-manifests.js';
import { runUpdateCheck, updateCheckEnabled } from './update-check.js';
import { WorkQueue } from './work-queue.js';

type OpencodeV2HandoffPlan = Extract<OpencodeV2HandoffBoundary, { status: 'ready' }>;

interface ScanResult {
    ingested: number;
    skipped?: FileSkip;
    // Complete records the adapter could not parse and skipped in this scan.
    malformedRecords?: number;
    // Complete records of an unrecognized shape the adapter skipped.
    unrecognizedRecords?: number;
    emptySession?: EmptySessionKind;
    v2HasMore?: boolean;
    v2NextCursor?: { watermark: number; cursorId: string };
    v2PendingRoundsRemaining?: number;
}

export interface BackfillIncomplete {
    source: string;
    category: FileSkipCategory | 'listing failed' | 'malformed records';
    reason: string;
}

export interface BackfillReport {
    ingested: number;
    incomplete: BackfillIncomplete[];
}

// Skips that leave eligible history uncaptured and can succeed on a retry once
// the file is readable, smaller or capacity is freed. Every other category is
// an intentional exclusion or an empty session, not missing work.
const BACKFILL_INCOMPLETE_SKIP_CATEGORIES = new Set<FileSkipCategory>([
    'unreadable content',
    'oversized record',
    'unexpected error',
    'capacity deferred',
]);

interface SweepSummary {
    files: number;
    ingested: number;
    skipped: Map<FileSkipCategory, number>;
    emptySessions: Map<EmptySessionKind, number>;
}

const NOTABLE_FILE_SKIP_CATEGORIES = new Set<FileSkipCategory>([
    'unreadable content',
    'oversized record',
    'unexpected error',
    'outside watched store',
    'capacity deferred',
]);

export const FIRST_PROMPT_SEARCH_BACKFILL_LOG_PREFIX = '[elepha] first-prompt search backfill:';

// How often to look for sessions that have gone quiet. Well under the idle
// threshold so a closed session rolls up promptly rather than up to a full
// threshold late.

// A format change can create one unknown line per transcript record. Keep the
// daemon log useful by emitting each distinct adapter message once, while a
// bounded FIFO prevents a long-lived process from retaining unbounded keys.
export function deduplicateDaemonUnknownLineWarnings(
    warn: (message: string) => void,
    limit = MAX_DAEMON_UNKNOWN_LINE_WARNINGS,
): (message: string) => void {
    const max = Math.max(1, limit);
    const seen = new Set<string>();
    const order: string[] = [];
    return (message) => {
        if (seen.has(message)) {
            return;
        }
        if (order.length === max) {
            const oldest = order.shift();
            if (oldest !== undefined) {
                seen.delete(oldest);
            }
        }
        seen.add(message);
        order.push(message);
        warn(message);
    };
}

// chokidar 5 dropped glob-pattern support in watch paths - it only accepts
// literal files/directories and watches them recursively. Glob-shaped
// filtering (*.jsonl under a project subdir, rollout-*.jsonl under a date
// subdir) happens ourselves via SessionAdapter.matches() on every raw event.
//
// Resolved per call, not frozen at module load: both roots honor an env var
// (CLAUDE_CONFIG_DIR / CODEX_HOME), and a module-level constant would bake in
// whatever the environment looked like at import time.
export function watchRoots(): string[] {
    const roots = [claudeProjectsRoot(), codexSessionsRoot()];
    const opencodeRoot = opencodeStoreRoot();
    if (existsSync(opencodeRoot)) {
        roots.push(opencodeRoot);
    }
    return roots;
}

export interface DaemonOptions {
    store: MemoryStore;
    summarizer?: SummarizationProvider;
    adapters?: SessionAdapter[];
    idleDebounceMs?: number;
    maxConcurrentSummaries?: number;
    log?: (msg: string) => void;
    logError?: (msg: string) => void;
    // Overrides the watched roots. Tests use repository-owned fixtures instead
    // of the real Claude Code and Codex stores.
    watchRoots?: string[];
    // Overrides the heartbeat file path. Defaults to ~/.elepha/daemon.heartbeat.json; tests point this at a temp file.
    heartbeatPath?: string;
    // Test seam for launchd-managed logs. Production uses the canonical ~/.elepha/logs paths.
    daemonLogPaths?: DaemonLogPaths;
    // Session rollups. Omit to disable rollups entirely (tests that only exercise turn ingestion).
    rollupService?: RollupService;
    // Mechanical rollup state only: capture-only activity reopens an existing final rollup without synthesizing it.
    rollups?: Pick<RollupStore, 'markLive'>;
    // How often to sweep for sessions gone idle. Defaults to SWEEP_INTERVAL_MS.
    sweepIntervalMs?: number;
    // Test seam for the daemon-owned registry check. The hook never uses it.
    updateCheck?: () => Promise<unknown> | unknown;
    // How often to revisit the persisted 24-hour update-check cache.
    updateCheckIntervalMs?: number;
    // Test seams for retirement when npm removes or replaces the running package.
    readInstalledPackageVersion?: () => string | undefined;
    exit?: (code: number) => void;
    // Forces chokidar to poll instead of using native OS watch descriptors
    // (fsevents on macOS, inotify on Linux). Off by default - native watching
    // is cheaper and this changes real filesystem-event behavior, so it's not
    // something to flip in production. Exists for test environments whose
    // sandbox restricts the underlying `watch` syscall itself (distinct from
    // the process fd ulimit - polling never calls it, it just stats on an
    // interval). Daemon-backed tests opt into polling explicitly.
    watcherUsePolling?: boolean;
    // Poll interval in ms when watcherUsePolling is set. Defaults to 50ms.
    watcherPollIntervalMs?: number;
    // Reads capture preferences once at daemon startup; tests inject resolved values.
    readConfig?: typeof readMemoryConfig;
    // Test seam for counting corpus walks without changing filesystem traversal.
    readCorpus?: (watchRoot: string) => Promise<string[]>;
    // Test seam for deterministically exercising opened-object containment races.
    openTranscript?: ProviderTranscriptOpener;
    // Test seam; production uses FIRST_PROMPT_SEARCH_BACKFILL_BATCH_SIZE.
    firstPromptSearchBackfillBatchSize?: number;
    // Test seam; production uses the task-state manifest recovery bounds.
    taskStateManifestRecoveryBudget?: Partial<TaskStateManifestRecoveryBudget>;
    // Test seam; production uses RESUME_CONTEXT_STEP_BYTES and RESUME_CONTEXT_STEP_MS.
    resumeContextStep?: { bytes?: number; elapsedMs?: number };
    // Deterministic budget exhaustion without timing-dependent fixture sleeps.
    sessionKindReconciliationNow?: () => number;
    // Fake-clock seam for the failed-EOF synthesis grace.
    now?: () => number;
}

function formatDaemonLog(message: string, context: { tool?: string; sessionId?: string } = {}): string {
    const fields = [context.tool && `tool=${context.tool}`, context.sessionId && `session_id=${context.sessionId}`].filter(Boolean);
    return fields.length === 0 ? message : `${message} ${fields.join(' ')}`;
}

function openTurnSourceSnapshot(opened: {
    stat: { dev: number | bigint; ino: number | bigint; size: number; mtimeMs: number };
}): OpenTurnSourceSnapshot {
    const dev = String(opened.stat.dev);
    const ino = String(opened.stat.ino);
    const revision = createHash('sha256')
        .update(JSON.stringify([dev, ino, opened.stat.size, opened.stat.mtimeMs]))
        .digest('hex');
    return { dev, ino, size: opened.stat.size, mtimeMs: opened.stat.mtimeMs, revision };
}

export class IngestionDaemon {
    private kindReconciliationPromise: Promise<void> | undefined;
    private readonly sessionKindReconciliationNow: (() => number) | undefined;
    private readonly store: MemoryStore;
    private readonly summarizer: SummarizationProvider | undefined;
    private readonly adapters: SessionAdapter[];
    private readonly idleDebounceMs: number;
    private readonly log: (msg: string) => void;
    private readonly logError: (msg: string) => void;
    private readonly watchRoots: string[];
    private readonly heartbeatPath: string;
    private readonly daemonLogPaths: DaemonLogPaths;
    private readonly rollupService: RollupService | undefined;
    private readonly rollups: Pick<RollupStore, 'markLive'> | undefined;
    private readonly sweepIntervalMs: number;
    private readonly updateCheck: () => Promise<unknown> | unknown;
    private readonly updateCheckIntervalMs: number;
    private embeddingRefreshTimer: NodeJS.Timeout | undefined;
    private embeddingRefresh: EmbeddingRefresh | undefined;
    private embeddingRefreshPromise: Promise<void> | undefined;
    private readonly readInstalledPackageVersion: () => string | undefined;
    private readonly exit: (code: number) => void;
    private readonly watcherUsePolling: boolean;
    private readonly watcherPollIntervalMs: number;
    private readonly captureClaudeCode: boolean;
    private readonly captureCodex: boolean;
    private readonly captureOpencode: boolean;
    // The legacy `durable-capture` key controls OpenCode copies.
    // Claude Code and Codex copies follow retainsFilteredCopy().
    private readonly legacyDurableCapture: boolean;
    private readonly readCorpus: (watchRoot: string) => Promise<string[]>;
    private readonly openTranscript: ProviderTranscriptOpener;
    private readonly firstPromptSearchBackfillBatchSize: number;
    private readonly now: () => number;
    private sweepTimer: NodeJS.Timeout | undefined;
    private initialUpdateCheckTimer: NodeJS.Timeout | undefined;
    private updateCheckTimer: NodeJS.Timeout | undefined;
    private firstPromptSearchBackfillTimer: NodeJS.Timeout | undefined;
    private firstPromptSearchBackfillPromise: Promise<void> | undefined;
    private startupSweepPromise: Promise<void> | undefined;
    private readonly taskStateManifests: TaskStateManifestPublisher;

    // Per OpenCode database: the in-memory discovery position used while its
    // persisted V2 watermark is held behind a deferred chat. Later pages keep
    // capturing disjoint chats from here; a restart or the deferral's resume
    // replays from the persisted watermark, so nothing is omitted.
    private readonly opencodeHeldDiscovery = new Map<string, { watermark: number; cursorId: string }>();

    private missingPackageChecks = 0;
    private stopping = false;
    // Reconstruction of a resume context for a stored cursor recorded without
    // one, by session: its progress, or the completed context until the next
    // cursor advance records it.
    private readonly resumeReconstructions = new Map<string, { cursor: string; result: ResumeContextDerivationResult }>();
    // Cancels reconstruction reads when the daemon stops.
    private readonly stopController = new AbortController();
    private readonly resumeContextStep: { bytes: number; elapsedMs: number };
    private readonly startedAt = new Date().toISOString();

    private watcher: FSWatcher | undefined;
    private heartbeatTimer: NodeJS.Timeout | undefined;
    private readonly idleTimers = new Map<string, NodeJS.Timeout>();
    private readonly openTurnTimers = new Map<string, NodeJS.Timeout>();
    private readonly openTurnValidationEpochs = new Map<string, number>();
    private readonly processing = new Set<string>();
    private readonly workQueue: WorkQueue;
    private readonly opencodeAdapter: OpencodeAdapter;
    private stopPromise: Promise<void> | undefined;
    private signalHandlersInstalled = false;
    private readonly shutdownOnSignal = () => {
        void this.stop().catch((error: unknown) => this.logError(`[elepha] shutdown failed: ${(error as Error).message}`));
    };

    // Shared with the adapters' unknown-line warnings: one log line per distinct message, bounded FIFO.
    private readonly warnDeduplicated: (message: string) => void;
    private readonly failureWindow: FailureWindow;
    private readonly skippedFiles = new Map<string, FileSkip>();
    private readonly oversizedFileSkipCache = new Map<string, { size: number; mtimeMs: number; skipped: FileSkip }>();
    private readonly readabilityGuard = new ReadabilityGuard();
    // Classification per transcript file, so the rollup path doesn't re-read session_meta on every batch.
    private readonly kindCache = new Map<string, SessionClassification>();
    private readonly customTitleCache = new Map<
        string,
        { size: number; mtimeMs: number; scannedTo: number; customTitle: string | undefined }
    >();

    constructor(options: DaemonOptions) {
        this.log = options.log ?? (() => {});
        this.logError = options.logError ?? console.error;
        const readConfig = options.readConfig ?? readMemoryConfig;
        const configResult = readConfig();
        if ('error' in configResult) {
            throw new Error(`cannot start daemon: ${configResult.error}`);
        }
        this.captureClaudeCode = configResult.config.captureClaudeCode ?? true;
        this.captureCodex = configResult.config.captureCodex ?? true;
        this.captureOpencode = configResult.config.captureOpencode ?? true;
        this.legacyDurableCapture = configResult.config.durableCapture ?? false;
        this.store = options.store;
        this.openTranscript = options.openTranscript ?? openProviderTranscript;
        this.summarizer = options.summarizer;
        const warnUnknownLine = deduplicateDaemonUnknownLineWarnings(this.log);
        this.warnDeduplicated = warnUnknownLine;
        this.adapters = options.adapters ?? [new ClaudeCodeAdapter(warnUnknownLine), new CodexAdapter(warnUnknownLine)];
        this.opencodeAdapter = new OpencodeAdapter(warnUnknownLine);
        this.idleDebounceMs = options.idleDebounceMs ?? DEFAULT_IDLE_DEBOUNCE_MS;
        this.workQueue = new WorkQueue(options.maxConcurrentSummaries ?? DEFAULT_MAX_CONCURRENT, this.log, this.logError);
        this.failureWindow = new FailureWindow(this.log, this.logError);
        this.watchRoots = options.watchRoots ?? watchRoots();
        this.heartbeatPath = options.heartbeatPath ?? defaultHeartbeatPath();
        this.daemonLogPaths = options.daemonLogPaths ?? { stdout: daemonStdoutLogPath(), stderr: daemonStderrLogPath() };
        this.rollupService = options.rollupService;
        this.rollups = options.rollups;
        this.sweepIntervalMs = options.sweepIntervalMs ?? SWEEP_INTERVAL_MS;
        this.updateCheck =
            options.updateCheck ??
            (() =>
                runUpdateCheck({
                    statePath: updateCheckStatePath(),
                    markerPath: updateAvailablePath(),
                    enabled: updateCheckEnabled(),
                    queryVersions: installedAndLatestElephaVersionAsync,
                    warn: this.logError,
                }));
        this.updateCheckIntervalMs = options.updateCheckIntervalMs ?? UPDATE_CHECK_LOOP_INTERVAL_MS;
        this.readInstalledPackageVersion = options.readInstalledPackageVersion ?? readInstalledPackageVersion;
        this.exit = options.exit ?? ((code) => process.exit(code));
        this.watcherUsePolling = options.watcherUsePolling ?? false;
        this.watcherPollIntervalMs = options.watcherPollIntervalMs ?? 50;
        this.readCorpus = options.readCorpus ?? ((watchRoot) => readdir(watchRoot, { recursive: true }));
        this.firstPromptSearchBackfillBatchSize = options.firstPromptSearchBackfillBatchSize ?? FIRST_PROMPT_SEARCH_BACKFILL_BATCH_SIZE;
        this.sessionKindReconciliationNow = options.sessionKindReconciliationNow;
        this.now = options.now ?? Date.now;
        this.resumeContextStep = {
            bytes: options.resumeContextStep?.bytes ?? RESUME_CONTEXT_STEP_BYTES,
            elapsedMs: options.resumeContextStep?.elapsedMs ?? RESUME_CONTEXT_STEP_MS,
        };

        this.taskStateManifests = new TaskStateManifestPublisher({
            store: this.store,
            adapters: Object.fromEntries(this.adapters.map((adapter) => [adapter.tool, adapter])) as SessionAdapterMap,
            openTranscript: this.openTranscript,
            log: this.log,
            logError: this.logError,

            enqueue: (job) => this.workQueue.enqueue(job),
            stopped: () => this.stopping,
            budget: options.taskStateManifestRecoveryBudget,
        });
    }

    start(): void {
        this.installSignalHandlers();
        rotateDaemonLogs(this.daemonLogPaths);
        // Before any startup writer: the expiry observer and acknowledgement
        // state are ready, so the first heartbeat may already advertise them.

        // followSymlinks left at chokidar's default (true) deliberately:
        // false also blocks traversal through a symlinked ANCESTOR of the
        // watch root, not just symlinks inside it - macOS's /tmp -> /private/tmp
        // is exactly this shape, and a relocated CLAUDE_CONFIG_DIR could be
        // too. It is also not the real guard either way: a symlink
        // swapped in after the watch event fires would slip past a watch-time
        // check. The authoritative guard is the realpath containment re-check
        // in scanFile(), which runs immediately before any read.
        this.watcher = chokidar.watch(this.watchRoots, {
            persistent: true,
            // The initial corpus uses sweepStartupFiles() below: unlike
            // chokidar's fire-and-forget add events it has a defined end and
            // can report what every file did. New files still arrive here.
            ignoreInitial: true,
            ...(this.watcherUsePolling ? { usePolling: true, interval: this.watcherPollIntervalMs } : {}),
        });
        this.watcher.on('add', (filePath) => this.onFileEvent(filePath));
        this.watcher.on('change', (filePath) => this.onFileEvent(filePath));
        this.log(`[elepha] watching:\n  ${this.watchRoots.join('\n  ')}`);

        const continuation: KindReconciliationContinuation = { afterId: 0, incidents: 0, hasMore: true };
        const reconcileKinds = () =>
            reconcileSessionKinds(this.store, {
                openTranscript: this.openTranscript,
                stopped: () => this.stopping,
                log: this.log,
                warn: this.warnDeduplicated,
                continuation,
                now: this.sessionKindReconciliationNow,
            });
        const classification = reconcileKinds().catch((error: unknown) => {
            continuation.hasMore = false;
            this.logError(`[elepha] session classification failed; retry pending: ${(error as Error).message}`);
        });
        this.kindReconciliationPromise = classification
            .then(async () => {
                while (continuation.hasMore && !this.stopping) {
                    await yieldImmediate();
                    if (!this.stopping) {
                        await reconcileKinds();
                    }
                }
            })
            .catch((error: unknown) => {
                this.logError(`[elepha] session classification failed; retry pending: ${(error as Error).message}`);
            })
            .finally(() => settleSessionKindReconciliation(this.store.database));
        const startupSweep = classification
            .then(() => this.sweepStartupFiles())
            .catch((error: unknown) => {
                this.logError(`[elepha] startup sweep failed: ${(error as Error).message}`);
            });
        this.startupSweepPromise = startupSweep;
        void startupSweep.then(() => {
            if (this.startupSweepPromise === startupSweep) {
                this.startupSweepPromise = undefined;
            }
            this.workQueue.enqueue(() => this.taskStateManifests.recover());
        });
        this.firstPromptSearchBackfillTimer = setTimeout(() => {
            this.firstPromptSearchBackfillTimer = undefined;
            const task = classification
                .then(() => this.backfillFirstPromptSearch())
                .catch((error: unknown) => {
                    this.logError(`${FIRST_PROMPT_SEARCH_BACKFILL_LOG_PREFIX} failed: ${(error as Error).message}`);
                });
            this.firstPromptSearchBackfillPromise = task;
            void task.then(() => {
                if (this.firstPromptSearchBackfillPromise === task) {
                    this.firstPromptSearchBackfillPromise = undefined;
                }
            });
        }, 0);
        this.firstPromptSearchBackfillTimer.unref();

        writeHeartbeat(this.heartbeatPath, this.startedAt);
        this.heartbeatTimer = setInterval(() => this.refreshInstallationHeartbeat(), HEARTBEAT_INTERVAL_MS);
        this.heartbeatTimer.unref();

        // The registry request belongs to the background daemon, never the
        // synchronous SessionStart hook. The persisted state enforces the
        // 24-hour limit across restarts; this modest timer merely revisits it.
        const checkForUpdate = () => {
            try {
                void Promise.resolve(this.updateCheck()).catch((error: unknown) => {
                    this.logError(`[elepha] update check failed: ${(error as Error).message}`);
                });
            } catch (error) {
                this.logError(`[elepha] update check failed: ${(error as Error).message}`);
            }
        };
        this.initialUpdateCheckTimer = setTimeout(checkForUpdate, 0);
        this.initialUpdateCheckTimer.unref();
        this.updateCheckTimer = setInterval(checkForUpdate, this.updateCheckIntervalMs);
        this.updateCheckTimer.unref();

        this.embeddingRefreshTimer = setInterval(() => this.refreshEmbeddings(), EMBEDDING_REFRESH_INTERVAL_MS);
        this.embeddingRefreshTimer.unref();

        if (this.rollupService) {
            // Startup sweep: sessions that ended while the daemon was down will
            // never produce another file event, so nothing else would ever
            // close them.
            void classification
                .then(() => this.sweepIdleSessions())
                .catch((err: unknown) => this.logError(`[elepha] startup sweep failed: ${(err as Error).message}`));
            this.sweepTimer = setInterval(() => {
                void this.sweepIdleSessions().catch((err: unknown) => this.logError(`[elepha] sweep failed: ${(err as Error).message}`));
            }, this.sweepIntervalMs);
            this.sweepTimer.unref();
        }
    }

    async stop(): Promise<void> {
        this.stopping = true;
        this.stopController.abort();
        if (this.stopPromise) {
            return this.stopPromise;
        }
        this.stopPromise = this.stopInternal();
        return this.stopPromise;
    }

    // One bounded, cancellable step of reconstructing a stored cursor's resume
    // context from the source. Undefined while unfinished; the completed
    // context is kept until a cursor advance records its successor.
    private async reconstructResumeContext(
        adapter: SessionAdapter,
        handle: FileHandle,
        cursor: string,
        key: string,
        logContext: { tool?: string; sessionId?: string },
    ): Promise<ResumeContext | undefined> {
        const known = this.resumeReconstructions.get(key);
        if (known?.cursor === cursor && known.result.state === 'complete') {
            return known.result.context;
        }
        const endOffset = adapter.cursorPosition?.(cursor).byteOffset;
        if (endOffset === undefined || adapter.deriveResumeContext === undefined) {
            return undefined;
        }
        const from = known?.cursor === cursor && known.result.state === 'partial' ? known.result.progress : undefined;
        if (from === undefined) {
            this.log(formatDaemonLog('[elepha] reconstructing the resume context of a stored cursor from its source', logContext));
        }
        const result = await adapter.deriveResumeContext(handle, endOffset, {
            from,
            readBudget: { remaining: this.resumeContextStep.bytes },
            signal: AbortSignal.any([this.stopController.signal, AbortSignal.timeout(this.resumeContextStep.elapsedMs)]),
        });
        this.resumeReconstructions.set(key, { cursor, result });
        return result.state === 'complete' ? result.context : undefined;
    }

    private refreshEmbeddings(): void {
        if (this.stopping || this.embeddingRefresh) {
            return;
        }
        try {
            // Zero provider/thread work while disabled; never occupy an ingestion
            // queue slot or share its database connection during a batch.
            if (!getSetting('memory-plus').value || isMemoryLocked(this.store.database)) {
                return;
            }
            const refresh = startEmbeddingRefresh(this.store.database.name, (message) =>
                this.logError(`[elepha] automatic indexing: ${message}`),
            );
            this.embeddingRefresh = refresh;
            this.embeddingRefreshPromise = refresh.done
                .then((result) => {
                    if (result) {
                        this.log(
                            `[elepha] automatic indexing: ${result.generated} indexed, ${result.current} current, ${result.ineligibleOrEmpty} ineligible or empty, ${result.sourceChanged} changed (retry next pass), ${result.failed} malformed (no inference)`,
                        );
                    }
                })
                .catch((error: unknown) => {
                    this.logError(`[elepha] automatic indexing failed; will retry next pass: ${(error as Error).message}`);
                })
                .finally(() => {
                    this.embeddingRefresh = undefined;
                    this.embeddingRefreshPromise = undefined;
                });
        } catch (error) {
            this.logError(`[elepha] automatic indexing failed; will retry next pass: ${(error as Error).message}`);
        }
    }

    private refreshInstallationHeartbeat(): void {
        let installedVersion: string | undefined;
        try {
            installedVersion = this.readInstalledPackageVersion();
        } catch {
            installedVersion = undefined;
        }

        if (installedVersion === PACKAGE_VERSION) {
            this.missingPackageChecks = 0;
            writeHeartbeat(this.heartbeatPath, this.startedAt);
            return;
        }
        if (installedVersion === undefined) {
            this.missingPackageChecks++;
            if (this.missingPackageChecks < DAEMON_MISSING_PACKAGE_CHECK_LIMIT) {
                writeHeartbeat(this.heartbeatPath, this.startedAt);
                return;
            }
            this.retireInstallation(0);
            return;
        }
        this.retireInstallation(DAEMON_PACKAGE_REPLACED_EXIT_CODE);
    }

    private retireInstallation(exitCode: number): void {
        if (this.stopping) {
            return;
        }
        void this.stop().then(
            () => this.exit(exitCode),
            (error: unknown) => {
                this.logError(`[elepha] installation retirement failed: ${(error as Error).message}`);
                this.exit(DAEMON_PACKAGE_REPLACED_EXIT_CODE);
            },
        );
    }

    private installSignalHandlers(): void {
        if (this.signalHandlersInstalled) {
            return;
        }
        process.once('SIGINT', this.shutdownOnSignal);
        process.once('SIGTERM', this.shutdownOnSignal);
        this.signalHandlersInstalled = true;
    }

    private removeSignalHandlers(): void {
        if (!this.signalHandlersInstalled) {
            return;
        }
        process.off('SIGINT', this.shutdownOnSignal);
        process.off('SIGTERM', this.shutdownOnSignal);
        this.signalHandlersInstalled = false;
    }

    private async stopInternal(): Promise<void> {
        this.removeSignalHandlers();
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
        }

        this.opencodeHeldDiscovery.clear();
        if (this.sweepTimer) {
            clearInterval(this.sweepTimer);
        }
        if (this.initialUpdateCheckTimer) {
            clearTimeout(this.initialUpdateCheckTimer);
        }
        if (this.updateCheckTimer) {
            clearInterval(this.updateCheckTimer);
        }
        if (this.embeddingRefreshTimer) {
            clearInterval(this.embeddingRefreshTimer);
        }
        this.embeddingRefresh?.stop();
        if (this.firstPromptSearchBackfillTimer) {
            clearTimeout(this.firstPromptSearchBackfillTimer);
        }
        clearHeartbeat(this.heartbeatPath);
        for (const timer of this.idleTimers.values()) {
            clearTimeout(timer);
        }
        this.idleTimers.clear();
        for (const timer of this.openTurnTimers.values()) {
            clearTimeout(timer);
        }
        this.openTurnTimers.clear();
        await this.watcher?.close();
        await this.startupSweepPromise;
        await this.kindReconciliationPromise;
        await this.firstPromptSearchBackfillPromise;
        await this.embeddingRefreshPromise;
    }

    private async backfillFirstPromptSearch(): Promise<void> {
        const adapters = Object.fromEntries(this.adapters.map((adapter) => [adapter.tool, adapter])) as SessionAdapterMap;
        let afterSessionId = 0;
        while (!this.stopping) {
            const consentedProjectIds = new ProjectResolver(this.store.database)
                .listConsentedStored(this.store.consent)
                .flatMap((project) => project.projectIds);
            if (consentedProjectIds.length === 0) {
                return;
            }
            const projectPlaceholders = consentedProjectIds.map(() => '?').join(', ');
            const candidates = this.store.database
                .prepare(
                    `SELECT s.id
                     FROM sessions s
                     LEFT JOIN first_prompt_search_backfill_skips AS skips ON skips.session_id = s.id
                     WHERE s.project_id IN (${projectPlaceholders})
                       AND s.id > ?
                       AND s.first_prompt_search IS NULL
                       AND ${SERVED_SESSION_KIND_ELIGIBILITY}
                       AND skips.session_id IS NULL
                     ORDER BY id
                     LIMIT ?`,
                )
                .all(...consentedProjectIds, afterSessionId, this.firstPromptSearchBackfillBatchSize) as Array<{ id: number }>;
            if (candidates.length === 0) {
                return;
            }

            const sessionIds = candidates.map((candidate) => candidate.id);
            let writeAuthorizedProjectIds: Set<number> | undefined;

            const plan = await applyFirstPromptSearchBackfill(this.store.database, adapters, {
                sessionIds,
                onlyNull: true,

                authorizeWrite: (db, sessionId) => {
                    writeAuthorizedProjectIds ??= new Set(
                        new ProjectResolver(db).listConsentedStored(this.store.consent).flatMap((project) => project.projectIds),
                    );
                    const row = db
                        .prepare(`SELECT project_id FROM sessions s WHERE id = ? AND ${SERVED_SESSION_KIND_ELIGIBILITY}`)
                        .get(sessionId) as { project_id: number } | undefined;
                    return row !== undefined && writeAuthorizedProjectIds.has(row.project_id);
                },
            });
            const lastCandidate = candidates.at(-1);
            if (lastCandidate === undefined) {
                return;
            }
            const lastSessionId = lastCandidate.id;
            afterSessionId = lastSessionId;

            const placeholders = sessionIds.map(() => '?').join(', ');
            const leftNullRows = this.store.database
                .prepare(
                    `SELECT id FROM sessions s WHERE id IN (${placeholders}) AND first_prompt_search IS NULL AND ${SERVED_SESSION_KIND_ELIGIBILITY}`,
                )
                .all(...sessionIds) as Array<{ id: number }>;
            const recordSkips = this.store.database.transaction((rows: Array<{ id: number }>) => {
                const currentlyConsented = new Set(
                    new ProjectResolver(this.store.database)
                        .listConsentedStored(this.store.consent)
                        .flatMap((project) => project.projectIds),
                );
                const insert = this.store.database.prepare(
                    'INSERT OR IGNORE INTO first_prompt_search_backfill_skips (session_id, skipped_at) VALUES (?, ?)',
                );
                const sessionProject = this.store.database.prepare(
                    `SELECT project_id FROM sessions s WHERE id = ? AND ${SERVED_SESSION_KIND_ELIGIBILITY}`,
                );
                const skippedAt = new Date().toISOString();
                for (const row of rows) {
                    const session = sessionProject.get(row.id) as { project_id: number } | undefined;
                    if (session === undefined || !currentlyConsented.has(session.project_id)) {
                        continue;
                    }

                    insert.run(row.id, skippedAt);
                }
            });
            const readableChanges = new Set(plan.changes.filter((change) => !change.transcriptMissing).map((change) => change.sessionId));
            recordSkips(leftNullRows.filter((row) => !readableChanges.has(row.id)));

            const remaining = (
                this.store.database
                    .prepare(
                        `SELECT COUNT(*) AS count
                         FROM sessions s
                         LEFT JOIN first_prompt_search_backfill_skips AS skips ON skips.session_id = s.id
                         WHERE s.project_id IN (${projectPlaceholders})
                           AND s.first_prompt_search IS NULL
                           AND ${SERVED_SESSION_KIND_ELIGIBILITY}
                           AND skips.session_id IS NULL`,
                    )
                    .get(...consentedProjectIds) as { count: number }
            ).count;
            this.log(
                `${FIRST_PROMPT_SEARCH_BACKFILL_LOG_PREFIX} processed through session ${lastSessionId}: ${sessionIds.length} session(s), ` +
                    `indexed ${plan.sessionsWritten}, left NULL ${leftNullRows.length} ` +
                    `(unavailable transcript: ${plan.sessionsMissingTranscript}), remaining ${remaining}`,
            );

            if (this.stopping) {
                return;
            }
            await new Promise<void>((resolve) => setImmediate(resolve));
        }
    }

    private adapterFor(filePath: string, onSkipped?: (skipped: FileSkip) => void): SessionAdapter | undefined {
        const adapter = this.adapters.find((a) => a.matches(filePath));
        if (!adapter) {
            return undefined;
        }
        const enabled = adapter.tool === 'claude-code' ? this.captureClaudeCode : this.captureCodex;
        if (!enabled) {
            const skipped = this.recordSkippedFile(
                filePath,
                {
                    category: 'capture disabled',
                    reason: `capture is disabled for ${adapter.tool}`,
                },
                { tool: adapter.tool, sessionId: adapter.nativeSessionId(filePath) },
            );
            onSkipped?.(skipped);
            return undefined;
        }
        return adapter;
    }

    private onFileEvent(filePath: string): void {
        for (const adapter of this.adapters) {
            const source = adapter.eventSourcePath?.(filePath);
            if (source) {
                filePath = source;
                break;
            }
        }
        const opencodeDatabase = this.opencodeDatabaseForEvent(filePath);
        if (opencodeDatabase) {
            this.scheduleOpencodeScan(opencodeDatabase);
            return;
        }
        const adapter = this.adapterFor(filePath);
        if (!adapter) {
            return;
        }

        this.beginOpenTurnValidation(adapter.tool, adapter.nativeSessionId(filePath));

        const openTurnTimer = this.openTurnTimers.get(filePath);
        if (openTurnTimer) {
            clearTimeout(openTurnTimer);
            this.openTurnTimers.delete(filePath);
        }

        this.enqueueScan(adapter, filePath, false);

        this.scheduleIdleScan(adapter, filePath);
    }

    private beginOpenTurnValidation(tool: ToolName, nativeId: string): number {
        const key = `${tool}\0${nativeId}`;
        const minimumEpoch = (this.openTurnValidationEpochs.get(key) ?? 0) + 1;
        const epoch = this.store.beginOpenTurnValidation(tool, nativeId, minimumEpoch);
        this.openTurnValidationEpochs.set(key, epoch);
        return epoch;
    }

    private isCurrentOpenTurnValidation(tool: ToolName, nativeId: string, epoch: number): boolean {
        return this.openTurnValidationEpochs.get(`${tool}\0${nativeId}`) === epoch;
    }

    private scheduleIdleScan(adapter: SessionAdapter, filePath: string): void {
        const existing = this.idleTimers.get(filePath);
        if (existing) {
            clearTimeout(existing);
        }
        this.idleTimers.set(
            filePath,
            setTimeout(() => {
                this.idleTimers.delete(filePath);
                this.enqueueScan(adapter, filePath, true);
            }, this.idleDebounceMs),
        );
    }

    private enqueueScan(adapter: SessionAdapter, filePath: string, closeTrailingOnIdle: boolean): void {
        this.workQueue.enqueue(async () => {
            await this.scanFile(adapter, filePath, closeTrailingOnIdle);
        });
    }

    private scheduleOpenTurnScan(adapter: SessionAdapter, filePath: string, delayMs: number): void {
        const existing = this.openTurnTimers.get(filePath);
        if (existing) {
            clearTimeout(existing);
        }
        this.openTurnTimers.set(
            filePath,
            setTimeout(
                () => {
                    this.openTurnTimers.delete(filePath);
                    this.enqueueScan(adapter, filePath, true);
                },
                Math.max(0, delayMs),
            ),
        );
    }

    private opencodeDatabaseForEvent(filePath: string): string | undefined {
        const databasePath = opencodeDbPath();
        const watchedPaths = [databasePath, `${databasePath}-wal`, `${databasePath}-shm`];
        if (!isWithin(opencodeStoreRoot(), filePath) || !watchedPaths.some((candidate) => samePath(candidate, filePath))) {
            return undefined;
        }
        return canonicalizeExisting(databasePath);
    }

    private scheduleOpencodeScan(databasePath: string, pendingRoundsRemaining?: number): void {
        const canonicalPath = canonicalizeExisting(databasePath);
        const existing = this.idleTimers.get(canonicalPath);
        if (existing) {
            clearTimeout(existing);
        }
        this.idleTimers.set(
            canonicalPath,
            setTimeout(() => {
                this.idleTimers.delete(canonicalPath);
                if (pendingRoundsRemaining === undefined) {
                    this.enqueueOpencodeScan(canonicalPath);
                } else {
                    this.enqueueOpencodeScan(canonicalPath, pendingRoundsRemaining);
                }
            }, this.idleDebounceMs),
        );
    }

    private enqueueOpencodeScan(databasePath: string, pendingRoundsRemaining?: number): void {
        this.workQueue.enqueue(async () => {
            await this.scanOpencodeDb(databasePath, undefined, undefined, pendingRoundsRemaining);
        });
    }

    // Replays local transcripts for one newly-approved root without enabling a
    // synthesis provider. Approval must make the already-written transcript
    // useful, but it must not turn a CLI acknowledgement into unbounded API
    // spend. The normal daemon will continue with provider work on new turns.
    async backfillApprovedRoot(root: string): Promise<number> {
        return this.backfillApprovedRoots([root]);
    }

    // Replays the provider corpus once for every newly-approved root in the set.
    async backfillApprovedRoots(roots: string[]): Promise<number> {
        return (await this.backfillApprovedRootsReport(roots)).ingested;
    }

    // The same replay, also naming every source it could not finish. A missing
    // provider store is legitimately empty history and exclusions such as
    // consent, incognito or purge are intentional, so neither is incomplete.
    async backfillApprovedRootsReport(roots: string[]): Promise<BackfillReport> {
        const canonicalRoots = [...new Set(roots.map((root) => canonicalizeExisting(root)))];
        const report: BackfillReport = { ingested: 0, incomplete: [] };
        if (canonicalRoots.length === 0) {
            return report;
        }
        const noteSkip = (source: string, skipped: FileSkip | undefined): void => {
            if (skipped !== undefined && BACKFILL_INCOMPLETE_SKIP_CATEGORIES.has(skipped.category)) {
                report.incomplete.push({ source, category: skipped.category, reason: skipped.reason });
            }
        };
        const scannedOpencodeDatabases = new Set<string>();
        for (const watchRoot of this.watchRoots) {
            let files: string[];
            try {
                files = await this.readCorpus(watchRoot);
            } catch (error: unknown) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                    report.incomplete.push({ source: watchRoot, category: 'listing failed', reason: errorMessage(error) });
                }
                continue;
            }
            for (const relativePath of files.sort()) {
                const filePath = path.join(watchRoot, relativePath);
                const opencodeDatabase = this.opencodeDatabaseForEvent(filePath);
                if (opencodeDatabase && !scannedOpencodeDatabases.has(opencodeDatabase)) {
                    scannedOpencodeDatabases.add(opencodeDatabase);
                    const result = await this.backfillOpencodeDb(opencodeDatabase, canonicalRoots);
                    report.ingested += result.ingested;
                    for (const skipped of result.skipped) {
                        noteSkip(opencodeDatabase, skipped);
                    }
                    continue;
                }
                const adapter = this.adapterFor(filePath);
                if (adapter) {
                    const result = await this.scanFile(adapter, filePath, true, canonicalRoots);
                    report.ingested += result.ingested;
                    noteSkip(filePath, result.skipped);
                    // Valid turns from this file stay stored; the unparseable
                    // or unrecognized records beside them are the incomplete part.
                    const skippedRecords = [
                        (result.malformedRecords ?? 0) > 0
                            ? `${result.malformedRecords} complete record(s) could not be parsed`
                            : undefined,
                        (result.unrecognizedRecords ?? 0) > 0
                            ? `${result.unrecognizedRecords} record(s) had an unrecognized shape`
                            : undefined,
                    ].filter((part) => part !== undefined);
                    if (skippedRecords.length > 0) {
                        report.incomplete.push({
                            source: filePath,
                            category: 'malformed records',
                            reason: `${skippedRecords.join(' and ')} and were skipped`,
                        });
                    }
                }
            }
        }
        return report;
    }

    // Pages one OpenCode database for the approved roots until it is drained.
    private async backfillOpencodeDb(
        databasePath: string,
        canonicalRoots: readonly string[],
    ): Promise<{ ingested: number; skipped: Array<FileSkip | undefined> }> {
        let result = await this.scanOpencodeDb(databasePath, canonicalRoots);
        const outcome = { ingested: result.ingested, skipped: [result.skipped] };
        while (result.v2HasMore && result.v2NextCursor !== undefined) {
            result = await this.scanOpencodeDb(databasePath, canonicalRoots, result.v2NextCursor, result.v2PendingRoundsRemaining);
            outcome.ingested += result.ingested;
            outcome.skipped.push(result.skipped);
        }
        return outcome;
    }

    // Cold-start work is intentionally an ordered, awaited sweep rather than
    // unbounded initial watch events. scanFile() is its file boundary: one
    // bad transcript reports a skip and cannot prevent a later one from being
    // read.
    private async sweepStartupFiles(): Promise<void> {
        const summary: SweepSummary = { files: 0, ingested: 0, skipped: new Map(), emptySessions: new Map() };
        const scannedOpencodeDatabases = new Set<string>();
        for (const watchRoot of this.watchRoots) {
            const files = await this.readCorpus(watchRoot).catch((err: unknown) => {
                this.logError(`[elepha] startup sweep could not list ${watchRoot}: ${(err as Error).message}`);
                return [] as string[];
            });
            for (const relativePath of files.sort()) {
                const filePath = path.join(watchRoot, relativePath);
                const opencodeDatabase = this.opencodeDatabaseForEvent(filePath);
                if (opencodeDatabase) {
                    if (scannedOpencodeDatabases.has(opencodeDatabase)) {
                        continue;
                    }
                    scannedOpencodeDatabases.add(opencodeDatabase);
                    summary.files++;
                    const result = await this.scanOpencodeDb(opencodeDatabase);
                    summary.ingested += result.ingested;
                    if (result.skipped) {
                        summary.skipped.set(result.skipped.category, (summary.skipped.get(result.skipped.category) ?? 0) + 1);
                    }
                    this.scheduleOpencodeScan(opencodeDatabase);
                    continue;
                }
                let adapterSkip: FileSkip | undefined;
                const adapter = this.adapterFor(filePath, (skipped) => {
                    adapterSkip = skipped;
                });
                if (!adapter) {
                    if (adapterSkip) {
                        summary.skipped.set(adapterSkip.category, (summary.skipped.get(adapterSkip.category) ?? 0) + 1);
                    }
                    continue;
                }
                summary.files++;
                // Every file in this one-time cold-start replay predates the
                // daemon process, so its final assistant response is already
                // complete. Close that trailing turn now; the live watcher
                // still uses false and relies on its idle debounce.
                const result = await this.scanFile(adapter, filePath, true);
                summary.ingested += result.ingested;
                if (result.emptySession) {
                    summary.emptySessions.set(result.emptySession, (summary.emptySessions.get(result.emptySession) ?? 0) + 1);
                }
                if (result.skipped) {
                    summary.skipped.set(result.skipped.category, (summary.skipped.get(result.skipped.category) ?? 0) + 1);
                }
            }
        }
        const skipped = [...summary.skipped.entries()];
        const emptySessions = [...summary.emptySessions.entries()];
        const reasonSummary = skipped.length === 0 ? 'none' : skipped.map(([reason, count]) => `${reason}: ${count}`).join('; ');
        const emptySummary =
            emptySessions.length === 0
                ? ''
                : `, empty sessions: ${emptySessions.reduce((total, [, count]) => total + count, 0)} (${emptySessions.map(([kind, count]) => `${kind}: ${count}`).join('; ')})`;
        this.log(
            `[elepha] startup sweep: scanned ${summary.files} file(s), ingested ${summary.ingested} turn(s), ` +
                `skipped ${skipped.reduce((total, [, count]) => total + count, 0)} file(s) (${reasonSummary})${emptySummary}`,
        );
    }

    private recordSkippedFile(filePath: string, skipped: FileSkip, context?: { tool?: string; sessionId?: string }): FileSkip {
        const canonicalPath = canonicalizeExisting(filePath);
        const previous = this.skippedFiles.get(canonicalPath);
        this.skippedFiles.set(canonicalPath, skipped);
        if (
            NOTABLE_FILE_SKIP_CATEGORIES.has(skipped.category) &&
            (previous?.category !== skipped.category || previous.reason !== skipped.reason)
        ) {
            this.log(formatDaemonLog(`[elepha] skipped ${filePath}: ${skipped.reason}`, context));
        }
        return skipped;
    }

    // A purge is permanent; an automatic retention removal lasts until a
    // pre-cleanup backup is restored. Both keep the transcript out of capture.
    private blockedTranscriptSkip(tool: ToolName, nativeId: string): FileSkip {
        return this.store.isTranscriptPurged(tool, nativeId)
            ? { category: 'purged', reason: `transcript ${nativeId} was purged and is permanently excluded from ingestion` }
            : {
                  category: 'retention removed',
                  reason: `transcript ${nativeId} was removed at live-memory capacity and is excluded from ingestion`,
              };
    }

    // A capacity deferral is an explicit coverage gap, already recorded in the
    // database; the file is retried from its unadvanced cursor on the next scan.
    private fileSkipForError(error: unknown): FileSkip {
        if (
            error instanceof LiveMemoryCaptureDeferredError ||
            error instanceof LiveMemoryCapacityError ||
            isLiveMemoryCapacityGuardError(error)
        ) {
            return { category: 'capacity deferred', reason: (error as Error).message };
        }
        if (error instanceof LiveMemoryRetentionVerificationError) {
            this.logError(`[elepha] ${error.message}`);
        }
        return { category: 'unexpected error', reason: `unexpected error: ${(error as Error).message}` };
    }

    private quarantineOversizedTranscript(
        filePath: string,
        error: OversizedTranscriptRecordError,
        context: { tool?: string; sessionId?: string },
        fileStat?: { size: number; mtimeMs: number },
    ): FileSkip {
        if (this.skippedFiles.get(filePath)?.category !== 'oversized record') {
            this.skippedFiles.delete(filePath);
        }
        const skipped = this.recordSkippedFile(
            filePath,
            {
                category: 'oversized record',
                reason: error.message,
            },
            context,
        );
        if (fileStat) {
            this.oversizedFileSkipCache.set(filePath, {
                size: fileStat.size,
                mtimeMs: fileStat.mtimeMs,
                skipped,
            });
        }
        return skipped;
    }

    private async scanOpencodeDb(
        databasePath: string,
        onlyProjectRoots?: string | readonly string[],
        backfillV2Cursor?: { watermark: number; cursorId: string },
        pendingRoundsRemaining?: number,
    ): Promise<ScanResult> {
        const canonicalPath = canonicalizeExisting(databasePath);
        if (!this.captureOpencode) {
            return {
                ingested: 0,
                skipped: this.recordSkippedFile(
                    canonicalPath,
                    { category: 'capture disabled', reason: 'capture is disabled for opencode' },
                    { tool: 'opencode' },
                ),
            };
        }

        if (this.processing.has(canonicalPath)) {
            this.scheduleOpencodeScan(canonicalPath);
            return { ingested: 0 };
        }
        this.processing.add(canonicalPath);

        try {
            const db = openOpencodeDbReadonly(canonicalPath);
            try {
                const v2WatermarkKey = opencodeV2WatermarkKey(canonicalPath);
                const heldDiscovery = onlyProjectRoots === undefined ? this.opencodeHeldDiscovery.get(canonicalPath) : undefined;
                const v2Cursor =
                    onlyProjectRoots === undefined
                        ? (heldDiscovery ?? this.store.getSqliteSourceCursor(this.opencodeAdapter.tool, v2WatermarkKey))
                        : backfillV2Cursor;
                const v2Page = this.opencodeAdapter.dirtySessionsV2(db, v2Cursor);
                // V1 remains readable as history, but only V2 creates new memories.
                const discoveredIds = new Set(v2Page.sessions.map((session) => session.sessionId));
                const pendingRows = this.store.listOpencodeV2Pending(canonicalPath, OPENCODE_V2_PENDING_SCAN_LIMIT + 1);
                const pendingRoundsLeft =
                    pendingRoundsRemaining ??
                    (pendingRows.length > OPENCODE_V2_PENDING_SCAN_LIMIT
                        ? Math.ceil(this.store.countOpencodeV2Pending(canonicalPath) / OPENCODE_V2_PENDING_SCAN_LIMIT) - 1
                        : 0);
                const pendingById = new Map(pendingRows.slice(0, OPENCODE_V2_PENDING_SCAN_LIMIT).map((row) => [row.native_id, row]));
                const sessions = [
                    ...v2Page.sessions,
                    ...[...pendingById.keys()]
                        .filter((nativeId) => !discoveredIds.has(nativeId))
                        .map((nativeId) => this.opencodeAdapter.v2SessionById(db, nativeId))
                        .filter((session) => session !== undefined),
                ];
                const selectedRoots =
                    onlyProjectRoots === undefined
                        ? undefined
                        : (typeof onlyProjectRoots === 'string' ? [onlyProjectRoots] : onlyProjectRoots).map((root) =>
                              canonicalizeExisting(root),
                          );
                let ingested = 0;
                let pendingHasContinuation = false;
                let v2NextCursor: { watermark: number; cursorId: string } | undefined;

                const markConsumed = (session: (typeof sessions)[number]): void => {
                    if (
                        pendingRows.length > OPENCODE_V2_PENDING_SCAN_LIMIT &&
                        pendingById.has(session.sessionId) &&
                        this.store.consent.consentState(canonicalizeExisting(session.directory)) === 'approved'
                    ) {
                        this.store.touchOpencodeV2Pending(canonicalPath, session.sessionId, session.directory);
                    }
                    if (!discoveredIds.has(session.sessionId) || heldDiscovery !== undefined) {
                        return;
                    }
                    v2NextCursor = { watermark: session.timeUpdated, cursorId: session.sessionId };
                    if (onlyProjectRoots === undefined) {
                        this.store.setSqliteSourceCursor(this.opencodeAdapter.tool, v2WatermarkKey, v2NextCursor);
                    }
                };

                for (const session of sessions) {
                    const logContext = { tool: this.opencodeAdapter.tool, sessionId: session.sessionId };
                    const canonicalDirectory = canonicalizeExisting(session.directory);
                    if (selectedRoots !== undefined) {
                        const coveringRoot = selectedRoots.find((root) => isWithin(root, canonicalDirectory));
                        if (coveringRoot === undefined || this.store.consent.consentState(canonicalDirectory) !== 'approved') {
                            this.recordSkippedFile(
                                canonicalPath,
                                {
                                    category: 'unapproved root',
                                    reason: `${session.directory} is outside/unapproved for the selected backfill roots; skipped before parsing transcript content`,
                                },
                                logContext,
                            );
                            markConsumed(session);
                            continue;
                        }
                    } else {
                        if (this.store.consent.isRefusedForCapture(session.directory)) {
                            this.recordSkippedFile(
                                canonicalPath,
                                {
                                    category: 'refused root',
                                    reason: `refusing to ingest from "${session.directory}" - not a permitted project root`,
                                },
                                logContext,
                            );
                            markConsumed(session);
                            continue;
                        }
                        const consentState = this.store.consent.consentState(canonicalDirectory);
                        if (consentState !== 'approved') {
                            if (consentState === 'denied') {
                                this.store.recordIncognitoTranscript(this.opencodeAdapter.tool, session.sessionId);
                                this.store.deleteOpencodeV2Pending(canonicalPath, session.sessionId);
                            }
                            const physicalDirectory = await realpath(session.directory).catch(() => undefined);
                            const directoryStat =
                                physicalDirectory === undefined ? undefined : await fsStat(physicalDirectory).catch(() => undefined);
                            if (physicalDirectory === undefined || !directoryStat?.isDirectory()) {
                                this.recordSkippedFile(
                                    canonicalPath,
                                    {
                                        category: 'unapproved root',
                                        reason: `${session.directory} is not an existing project directory; skipped before parsing transcript content`,
                                    },
                                    logContext,
                                );
                                markConsumed(session);
                                continue;
                            }
                            const root = this.store.consent.recordPending(physicalDirectory);
                            this.recordSkippedFile(
                                canonicalPath,
                                {
                                    category: 'unapproved root',
                                    reason: `${root.path} is not an approved memory root; skipped before parsing transcript content. Grant it with \`elepha consent grant ${root.path}\`.`,
                                },
                                logContext,
                            );
                            markConsumed(session);
                            continue;
                        }
                    }

                    if (this.store.isTranscriptCaptureBlocked(this.opencodeAdapter.tool, session.sessionId)) {
                        this.store.deleteOpencodeV2Pending(canonicalPath, session.sessionId);
                        this.recordSkippedFile(
                            canonicalPath,
                            this.blockedTranscriptSkip(this.opencodeAdapter.tool, session.sessionId),
                            logContext,
                        );
                        markConsumed(session);
                        continue;
                    }
                    if (this.store.isTranscriptIncognito(this.opencodeAdapter.tool, session.sessionId)) {
                        this.store.deleteOpencodeV2Pending(canonicalPath, session.sessionId);
                        this.recordSkippedFile(
                            canonicalPath,
                            {
                                category: 'incognito',
                                reason: `transcript ${session.sessionId} was observed while capture was denied and is permanently excluded from ingestion`,
                            },
                            logContext,
                        );
                        markConsumed(session);
                        continue;
                    }

                    const classification = this.opencodeAdapter.classifySession(session);
                    const skipLabel =
                        classification.exclusion ??
                        (classification.kind === 'fork-copy' || classification.kind === 'adjudicator' ? classification.kind : undefined);
                    if (skipLabel) {
                        this.recordSkippedFile(
                            canonicalPath,
                            {
                                category: 'excluded session',
                                reason: `skipping ${skipLabel} session ${session.sessionId}: ${classification.reason ?? ''}`,
                            },
                            logContext,
                        );
                        markConsumed(session);
                        continue;
                    }

                    const storedFormat = this.store.findSession(this.opencodeAdapter.tool, session.sessionId)?.source_format;
                    // A handed-off session carries a V1 turn-index offset that
                    // only the overlap path applies; its V1 row disappearing
                    // must not silently switch it to unshifted indexes.
                    if (
                        (storedFormat !== undefined && storedFormat !== 'opencode-v2') ||
                        this.store.getOpencodeV2Handoff(session.sessionId) !== undefined
                    ) {
                        this.recordSkippedFile(
                            canonicalPath,
                            {
                                category: 'excluded session',
                                reason: `OpenCode V2 session ${session.sessionId} overlaps historical V1 memory; V2 handoff is not verified`,
                            },
                            logContext,
                        );
                        markConsumed(session);
                        continue;
                    }

                    const pending = pendingById.get(session.sessionId);
                    const revision = this.opencodeAdapter.v2TailRevision(db, session.sessionId);
                    if (
                        pending !== undefined &&
                        pending.needs_continuation === 0 &&
                        pending.observed_seq === (revision?.seq ?? -1) &&
                        pending.observed_updated === (revision?.updated ?? -1)
                    ) {
                        markConsumed(session);
                        continue;
                    }
                    const storedCursorBefore = this.store.getSessionCursor(this.opencodeAdapter.tool, session.sessionId);
                    const cursor = pending?.resume_cursor ?? storedCursorBefore ?? undefined;
                    let sessionIngested = 0;
                    const progress: OpencodeV2ParseProgress = { hasMore: false, pending: false, omittedPrefix: false };

                    const turns = this.opencodeAdapter.parseSessionTurnsV2(db, session, cursor, progress);
                    for await (const turn of turns) {
                        const consentState = this.consentStateForTurn(turn);
                        if (consentState === 'denied') {
                            this.store.recordIncognitoTranscript(turn.tool, turn.sessionId);
                            break;
                        }
                        if (turn.droppedReason !== undefined) {
                            await this.advanceDroppedTurn(turn, undefined, classification);
                            if (this.store.isTranscriptIncognito(turn.tool, turn.sessionId)) {
                                break;
                            }
                            continue;
                        }
                        if (await this.persistTurn(this.opencodeAdapter, turn, undefined, classification)) {
                            ingested++;
                            sessionIngested++;
                        }
                        if (this.store.isTranscriptIncognito(turn.tool, turn.sessionId)) {
                            break;
                        }
                    }
                    const storedSession = this.store.findSession(this.opencodeAdapter.tool, session.sessionId);
                    if (storedSession !== undefined) {
                        this.store.updateSessionTitle(storedSession.id, {
                            aiTitle: opencodeSessionAiTitle(session.title),
                            userMessage: '',
                        });
                    }
                    if (sessionIngested > 0) {
                        await this.refreshRollup(this.opencodeAdapter, canonicalPath, session.sessionId, 'live', classification);
                    }
                    if (progress.skippedClosedCursor !== undefined) {
                        this.recordSkippedFile(
                            canonicalPath,
                            {
                                category: 'excluded session',
                                reason: `OpenCode V2 session ${session.sessionId} omitted an oversized old turn through ${progress.skippedClosedCursor}`,
                            },
                            logContext,
                        );
                    }
                    const storedCursorAfter = this.store.getSessionCursor(this.opencodeAdapter.tool, session.sessionId);
                    const resumeCursor =
                        storedCursorAfter !== storedCursorBefore
                            ? undefined
                            : (progress.skippedClosedCursor ?? pending?.resume_cursor ?? undefined);
                    if (this.store.isTranscriptIncognito(this.opencodeAdapter.tool, session.sessionId)) {
                        this.store.deleteOpencodeV2Pending(canonicalPath, session.sessionId);
                    } else if (revision !== undefined && (progress.pending || progress.hasMore || resumeCursor !== undefined)) {
                        this.store.upsertOpencodeV2Pending(
                            canonicalPath,
                            session.sessionId,
                            canonicalDirectory,
                            revision,
                            progress.hasMore,
                            resumeCursor,
                        );
                        pendingHasContinuation ||= progress.hasMore && storedCursorAfter !== storedCursorBefore;
                    } else {
                        this.store.deleteOpencodeV2Pending(canonicalPath, session.sessionId);
                    }
                    markConsumed(session);
                }

                // Approved-root backfill leaves same-ID sessions to the live
                // overlap cycle, which owns the persisted handoff state.
                let overlapContinuation = false;
                if (onlyProjectRoots === undefined) {
                    const overlap = await this.scanOpencodeV2Overlaps(db, canonicalPath);
                    ingested += overlap.ingested;
                    overlapContinuation = overlap.continuation;
                }
                if (heldDiscovery !== undefined) {
                    const roots = onlyProjectRoots;

                    // Discovery continues past the listed page in memory only.
                    const last = v2Page.sessions.at(-1);
                    const listed = last === undefined ? undefined : { watermark: last.timeUpdated, cursorId: last.sessionId };
                    if (roots === undefined && listed !== undefined) {
                        // Kept after the last page too, so later events read only
                        // new chats instead of re-walking every page while held.
                        this.opencodeHeldDiscovery.set(canonicalPath, listed);
                        if (v2Page.hasMore) {
                            this.scheduleOpencodeScan(canonicalPath);
                        }
                    }
                    return {
                        ingested,
                        skipped: ingested === 0 ? this.skippedFiles.get(canonicalPath) : undefined,
                        v2HasMore: v2Page.hasMore,
                        v2NextCursor: listed ?? backfillV2Cursor,
                    };
                }

                if (ingested > 0) {
                    this.skippedFiles.delete(canonicalPath);
                }
                if ((pendingHasContinuation || pendingRoundsLeft > 0) && v2NextCursor === undefined && backfillV2Cursor !== undefined) {
                    v2NextCursor = backfillV2Cursor;
                }
                if (
                    onlyProjectRoots === undefined &&
                    this.watcher !== undefined &&
                    (v2Page.hasMore || pendingHasContinuation || pendingRoundsLeft > 0 || overlapContinuation)
                ) {
                    this.scheduleOpencodeScan(canonicalPath, pendingRoundsLeft > 0 ? pendingRoundsLeft - 1 : undefined);
                }
                return {
                    ingested,
                    skipped: ingested === 0 ? this.skippedFiles.get(canonicalPath) : undefined,
                    v2HasMore: v2Page.hasMore || pendingHasContinuation || pendingRoundsLeft > 0 || overlapContinuation,
                    v2NextCursor,
                    v2PendingRoundsRemaining: pendingRoundsLeft > 0 ? pendingRoundsLeft - 1 : undefined,
                };
            } finally {
                db.close();
            }
        } catch (error) {
            return {
                ingested: 0,
                skipped: this.recordSkippedFile(canonicalPath, this.fileSkipForError(error), { tool: this.opencodeAdapter.tool }),
            };
        } finally {
            this.processing.delete(canonicalPath);
        }
    }

    // One bounded id-keyset page of same-ID V1/V2 sessions per scan, plus any
    // handed-off session whose previous pass stopped at a row budget. Unchanged
    // sessions are recognized by their persisted revision and cost no reparse
    // and no repeated log line.
    private async scanOpencodeV2Overlaps(
        db: ReturnType<typeof openOpencodeDbReadonly>,
        canonicalPath: string,
    ): Promise<{ ingested: number; continuation: boolean }> {
        const cursorKey = opencodeV2OverlapKey(canonicalPath);
        const afterId = this.store.getSqliteSourceCursor(this.opencodeAdapter.tool, cursorKey)?.cursorId || undefined;
        const page = this.opencodeAdapter.overlappingSessionsV2(db, afterId, OPENCODE_V2_OVERLAP_PAGE_SIZE);
        const pageIds = new Set(page.sessions.map((session) => session.sessionId));
        const continuing = this.store
            .listOpencodeV2HandoffContinuations(canonicalPath, OPENCODE_V2_OVERLAP_PAGE_SIZE)
            .filter((nativeId) => !pageIds.has(nativeId))
            .map((nativeId) => this.opencodeAdapter.overlappingSessionV2ById(db, nativeId))
            .filter((session) => session !== undefined);
        let ingested = 0;
        let continuation = false;

        for (const session of [...continuing, ...page.sessions]) {
            try {
                const result = await this.ingestOpencodeV2Overlap(db, canonicalPath, session);
                ingested += result.ingested;
                continuation ||= result.continuation;
            } catch (error) {
                // The handoff row keeps its previous revision, so this session
                // is retried when the cycle returns instead of blocking it.
                this.recordSkippedFile(
                    canonicalPath,
                    error instanceof LiveMemoryCaptureDeferredError
                        ? this.fileSkipForError(error)
                        : {
                              category: 'unexpected error',
                              reason: `unexpected error in OpenCode V2 handoff for ${session.sessionId}: ${(error as Error).message}`,
                          },
                    { tool: this.opencodeAdapter.tool, sessionId: session.sessionId },
                );
            }
        }

        // An empty cursor restarts the cycle, so an id inserted behind the last
        // visited key is reached on the next pass.
        this.store.setSqliteSourceCursor(this.opencodeAdapter.tool, cursorKey, {
            watermark: 0,
            cursorId: page.hasMore ? (page.lastId ?? '') : '',
        });
        return { ingested, continuation };
    }

    // Stored V1 memories stay frozen. V2 capture of the same native session
    // starts only at a verified migration boundary, in a new segment, with a
    // persisted turn-index offset; every unverifiable case abstains explicitly.
    private async ingestOpencodeV2Overlap(
        db: ReturnType<typeof openOpencodeDbReadonly>,
        canonicalPath: string,
        session: OpencodeV2OverlapSession,
    ): Promise<{ ingested: number; continuation: boolean }> {
        const none = { ingested: 0, continuation: false };
        const tool = this.opencodeAdapter.tool;
        const logContext = { tool, sessionId: session.sessionId };
        if (this.store.consent.isRefusedForCapture(session.directory)) {
            this.recordSkippedFile(
                canonicalPath,
                { category: 'refused root', reason: `refusing to ingest from "${session.directory}" - not a permitted project root` },
                logContext,
            );
            return none;
        }
        const canonicalDirectory = canonicalizeExisting(session.directory);
        const consentState = this.store.consent.consentState(canonicalDirectory);
        if (consentState !== 'approved') {
            if (consentState === 'denied') {
                this.store.recordIncognitoTranscript(tool, session.sessionId);
            }
            this.recordSkippedFile(
                canonicalPath,
                {
                    category: 'unapproved root',
                    reason: `${session.directory} is not an approved memory root; same-ID V1/V2 session skipped before parsing transcript content`,
                },
                logContext,
            );
            return none;
        }
        if (this.store.isTranscriptCaptureBlocked(tool, session.sessionId)) {
            this.recordSkippedFile(canonicalPath, this.blockedTranscriptSkip(tool, session.sessionId), logContext);
            return none;
        }
        if (this.store.isTranscriptIncognito(tool, session.sessionId)) {
            this.recordSkippedFile(
                canonicalPath,
                {
                    category: 'incognito',
                    reason: `transcript ${session.sessionId} was observed while capture was denied and is permanently excluded from ingestion`,
                },
                logContext,
            );
            return none;
        }

        const tail = this.opencodeAdapter.v2TailRevision(db, session.sessionId);
        if (tail === undefined) {
            return none;
        }
        const revision = { seq: tail.seq, updated: tail.updated, v1Updated: session.v1TimeUpdated };
        const prior = this.store.getOpencodeV2Handoff(session.sessionId);
        // The persisted V1 cursor and offset were verified against one source
        // database; another source path carrying the same native id never
        // inherits or rebinds that authority.
        if (prior !== undefined && prior.source_path !== canonicalPath) {
            this.recordSkippedFile(
                canonicalPath,
                {
                    category: 'excluded session',
                    reason: `OpenCode V2 handoff for ${session.sessionId} is bound to a different source database`,
                },
                logContext,
            );
            this.log(
                formatDaemonLog(
                    `[elepha] OpenCode V2 handoff refused for ${session.sessionId}: handoff is bound to a different source database`,
                    logContext,
                ),
            );
            return none;
        }
        if (
            prior !== undefined &&
            prior.needs_continuation === 0 &&
            prior.observed_seq === revision.seq &&
            prior.observed_updated === revision.updated &&
            prior.observed_v1_updated === revision.v1Updated
        ) {
            return none;
        }
        const stored = this.store.findSession(tool, session.sessionId);
        const abstain = (reason: string): { ingested: number; continuation: boolean } => {
            this.store.recordOpencodeV2Handoff(canonicalPath, session.sessionId, canonicalDirectory, {
                status: 'abstained',
                v1Cursor: stored?.source_format === 'native' ? (stored.cursor ?? undefined) : undefined,
                revision,
                needsContinuation: false,
                reason,
            });
            this.recordSkippedFile(
                canonicalPath,
                { category: 'excluded session', reason: `OpenCode V2 handoff abstained: ${reason}` },
                logContext,
            );
            this.log(formatDaemonLog(`[elepha] OpenCode V2 handoff abstained for ${session.sessionId}: ${reason}`, logContext));
            return none;
        };
        if (!session.sameParent) {
            return abstain('V1 and V2 rows disagree on the parent session');
        }

        let cursor: string;
        let turnIndexOffset: number;
        let handoff: { v1SessionId: number; v1Cursor: string | null; boundary: OpencodeV2HandoffPlan } | undefined;
        if (stored === undefined) {
            return abstain('no stored V1 history anchors the handoff');
        }
        if (stored.source_format === 'opencode-v2') {
            // The offset is persisted before the first V2 write, so a crash
            // between that write and the final status update still resumes.
            if (prior === undefined || prior.turn_index_offset === null || stored.cursor === null || !stored.cursor.startsWith('v2:')) {
                return abstain('stored V2 segment has no verified handoff offset');
            }
            cursor = stored.cursor;
            turnIndexOffset = prior.turn_index_offset;
        } else {
            const boundary = this.opencodeAdapter.v2HandoffBoundary(db, session.sessionId, stored.cursor);
            if (boundary.status === 'abstain') {
                return abstain(boundary.reason);
            }
            if (boundary.status === 'awaiting-user') {
                // Legitimately empty: no V2-native user exists yet after the
                // migrated prefix, so there is nothing new to capture.
                this.store.recordOpencodeV2Handoff(canonicalPath, session.sessionId, canonicalDirectory, {
                    status: 'waiting',
                    v1Cursor: stored.cursor ?? undefined,
                    revision,
                    needsContinuation: false,
                });
                return none;
            }
            turnIndexOffset = prior?.turn_index_offset ?? this.store.opencodeV1TurnIndexOffset(session.sessionId);
            cursor = boundary.startCursor;
            handoff = { v1SessionId: stored.id, v1Cursor: stored.cursor, boundary };
            // The offset is persisted before any V2 turn can be written. The
            // unmatched revision keeps a failed pass retryable.
            if (
                !this.store.recordOpencodeV2Handoff(canonicalPath, session.sessionId, canonicalDirectory, {
                    status: 'waiting',
                    v1Cursor: stored.cursor ?? undefined,
                    turnIndexOffset,
                    revision: { seq: -1, updated: -1, v1Updated: -1 },
                    needsContinuation: false,
                })
            ) {
                return none;
            }
        }

        const classification = this.opencodeAdapter.classifySession(session);
        const progress: OpencodeV2ParseProgress = { hasMore: false, pending: false, omittedPrefix: false };
        const storedCursorBefore = this.store.getSessionCursor(tool, session.sessionId);
        let ingested = 0;
        for await (const parsed of this.opencodeAdapter.parseSessionTurnsV2(db, session, cursor, progress)) {
            const handingOff = handoff !== undefined && this.store.findSession(tool, session.sessionId)?.source_format !== 'opencode-v2';
            const turn: ParsedTurn = { ...parsed, turnIndex: parsed.turnIndex + turnIndexOffset };
            if (handingOff && handoff !== undefined) {
                const plan = handoff;
                // Re-read inside the write transaction, after the summarizer
                // await: the V1 segment and its source anchor, and the V2
                // boundary, must still be exactly what this pass verified.
                turn.validateSource = () => {
                    const latest = this.store.findSession(tool, session.sessionId);
                    const again =
                        latest?.id === plan.v1SessionId && latest.source_format === 'native' && latest.cursor === plan.v1Cursor
                            ? this.opencodeAdapter.v2HandoffBoundary(db, session.sessionId, plan.v1Cursor)
                            : undefined;
                    const unchanged =
                        again?.status === 'ready' &&
                        again.startCursor === plan.boundary.startCursor &&
                        again.boundarySeq === plan.boundary.boundarySeq &&
                        again.boundaryId === plan.boundary.boundaryId;
                    if (!unchanged) {
                        this.log(
                            formatDaemonLog(
                                `[elepha] OpenCode V2 handoff write refused for ${session.sessionId}: V1 history or the V2 boundary changed before the write`,
                                logContext,
                            ),
                        );
                    }
                    return unchanged;
                };
            }
            const turnConsent = this.consentStateForTurn(turn);
            if (turnConsent === 'denied') {
                this.store.recordIncognitoTranscript(turn.tool, turn.sessionId);
                break;
            }
            if (turn.droppedReason !== undefined) {
                // Before the V2 segment exists the only stored cursor belongs
                // to V1 history, so a dropped turn must not move it.
                if (!handingOff) {
                    await this.advanceDroppedTurn(turn, undefined, classification);
                }
                if (this.store.isTranscriptIncognito(turn.tool, turn.sessionId)) {
                    break;
                }
                continue;
            }
            if (await this.persistTurn(this.opencodeAdapter, turn, undefined, classification, handingOff)) {
                ingested++;
            }
            if (this.store.isTranscriptIncognito(turn.tool, turn.sessionId)) {
                break;
            }
        }
        const latest = this.store.findSession(tool, session.sessionId);
        const active = latest?.source_format === 'opencode-v2';
        if (active) {
            this.store.updateSessionTitle(latest.id, { aiTitle: opencodeSessionAiTitle(session.title), userMessage: '' });
        }
        if (ingested > 0) {
            await this.refreshRollup(this.opencodeAdapter, canonicalPath, session.sessionId, 'live', classification);
        }
        if (progress.skippedClosedCursor !== undefined) {
            this.recordSkippedFile(
                canonicalPath,
                {
                    category: 'excluded session',
                    reason: `OpenCode V2 session ${session.sessionId} omitted an oversized old turn through ${progress.skippedClosedCursor}`,
                },
                logContext,
            );
        }
        if (this.store.isTranscriptIncognito(tool, session.sessionId)) {
            return { ingested, continuation: false };
        }
        // A page of dropped or quote-back turns still advances the cursor
        // without ingesting anything. Continuation follows cursor progress,
        // not ingestion; otherwise the unchanged revision is recorded as fully
        // observed and the rows past the page are never read. A pass that
        // cannot move the cursor stops rather than rereading the same page.
        const needsContinuation = progress.hasMore && this.store.getSessionCursor(tool, session.sessionId) !== storedCursorBefore;
        this.store.recordOpencodeV2Handoff(canonicalPath, session.sessionId, canonicalDirectory, {
            status: active ? 'active' : 'waiting',
            v1Cursor: stored.source_format === 'native' ? (stored.cursor ?? undefined) : undefined,
            turnIndexOffset,
            revision,
            needsContinuation,
        });
        return { ingested, continuation: needsContinuation };
    }

    private async scanFile(
        adapter: SessionAdapter,
        filePath: string,
        closeTrailingOnIdle: boolean,
        onlyProjectRoots?: string | readonly string[],
    ): Promise<ScanResult> {
        const logContext = { tool: adapter.tool, sessionId: adapter.nativeSessionId(filePath) };
        // Resolve, contain, and bind the physical file to one opened object
        // immediately before any adapter read. The same canonical path remains
        // the mutex key, so lexical aliases cannot scan one transcript concurrently.
        const opened = await this.openTranscript(adapter.tool, filePath);
        if ('reason' in opened) {
            return {
                ingested: 0,
                skipped: this.recordSkippedFile(
                    filePath,
                    {
                        category: 'outside watched store',
                        reason:
                            opened.reason === 'transcript_outside_store'
                                ? `resolves outside the ${adapter.tool} provider store (cross-store, escaping, or dangling symlink?)`
                                : `cannot open a stable regular file inside the ${adapter.tool} provider store (${opened.reason})`,
                    },
                    logContext,
                ),
            };
        }
        const { handle, resolvedPath: real, stat: openedStat } = opened;
        const nativeId = adapter.nativeSessionId(real);
        const openTurnSource = openTurnSourceSnapshot(opened);
        const openTurnGeneration = sourceGeneration(this.store, adapter.tool, nativeId);
        let openTurnValidationEpoch: number;

        openTurnValidationEpoch = this.beginOpenTurnValidation(adapter.tool, nativeId);

        // A second scan could read a cursor the first has not advanced yet and
        // re-emit a turn already in flight. Retry after the idle debounce so
        // trailing work is not missed when no later file event arrives.
        if (this.processing.has(real)) {
            await handle.close();
            this.scheduleIdleScan(adapter, filePath);
            return { ingested: 0 };
        }
        this.processing.add(real);
        let fileStat: { size: number; mtimeMs: number } | undefined;
        try {
            fileStat = { size: openedStat.size, mtimeMs: openedStat.mtimeMs };
            // Hide a staged snapshot as soon as a source append/replacement is
            // visible, before classification or any provider/model await can
            // let stale incomplete content escape concurrently.
            this.store.invalidateOpenTurnIfSourceChanged(adapter.tool, nativeId, openTurnGeneration, openTurnSource);
            const oversizedCached = this.oversizedFileSkipCache.get(real);
            if (oversizedCached && fileStat && fileStat.size === oversizedCached.size && fileStat.mtimeMs === oversizedCached.mtimeMs) {
                return { ingested: 0, skipped: oversizedCached.skipped };
            }
            if (oversizedCached) {
                this.oversizedFileSkipCache.delete(real);
                if (this.skippedFiles.get(real)?.category === 'oversized record') {
                    this.skippedFiles.delete(real);
                }
            }

            const unreadable = await this.readabilityGuard.assertReadableJsonl(real);
            if (unreadable) {
                return { ingested: 0, skipped: this.recordSkippedFile(real, unreadable, logContext) };
            }

            // Consent is a file boundary, not a persistence-only check. Read
            // only the first cwd-bearing metadata line, then reject before an
            // adapter can parse a turn, title, or any transcript body.
            const metadata = await readSessionMetadata(real);
            if (!metadata) {
                return {
                    ingested: 0,
                    skipped: this.recordSkippedFile(
                        real,
                        {
                            category: 'unapproved root',
                            reason: 'session cwd is unavailable from metadata; skipped before parsing transcript content',
                        },
                        logContext,
                    ),
                };
            }
            if (onlyProjectRoots !== undefined) {
                const selectedRoots = typeof onlyProjectRoots === 'string' ? [canonicalizeExisting(onlyProjectRoots)] : onlyProjectRoots;
                const canonicalCwd = canonicalizeExisting(metadata.cwd);
                const coveringRoot = selectedRoots.find((root) => isWithin(root, canonicalCwd));
                if (coveringRoot === undefined || this.store.consent.consentState(canonicalCwd) !== 'approved') {
                    return {
                        ingested: 0,
                        skipped: this.recordSkippedFile(
                            real,
                            {
                                category: 'unapproved root',
                                reason: `${metadata.cwd} is outside/unapproved for the selected backfill roots; skipped before parsing transcript content`,
                            },
                            logContext,
                        ),
                    };
                }
            }
            if (onlyProjectRoots === undefined) {
                if (this.store.consent.isRefusedForCapture(metadata.cwd)) {
                    return {
                        ingested: 0,
                        skipped: this.recordSkippedFile(
                            real,
                            {
                                category: 'refused root',
                                reason: `refusing to ingest from "${metadata.cwd}" - not a permitted project root`,
                            },
                            logContext,
                        ),
                    };
                }
                const consentState = this.store.consent.consentState(metadata.cwd);
                if (consentState !== 'approved') {
                    // Pending means the user has never opted in, so its first
                    // grant must still backfill history. Denied is an explicit
                    // no: only that state writes the permanent incognito veto.
                    // The stable tool/session key keeps a future forced disk
                    // re-scan possible without retaining any transcript content.
                    if (consentState === 'denied') {
                        this.store.recordIncognitoTranscript(adapter.tool, nativeId);
                    }
                    const canonicalCwd = await realpath(metadata.cwd).catch(() => undefined);
                    const cwdStat = canonicalCwd === undefined ? undefined : await fsStat(canonicalCwd).catch(() => undefined);
                    if (canonicalCwd === undefined || !cwdStat?.isDirectory()) {
                        return {
                            ingested: 0,
                            skipped: this.recordSkippedFile(
                                real,
                                {
                                    category: 'unapproved root',
                                    reason: `${metadata.cwd} is not an existing project directory; skipped before parsing transcript content`,
                                },
                                logContext,
                            ),
                        };
                    }
                    const root = this.store.consent.recordPending(canonicalCwd);
                    return {
                        ingested: 0,
                        skipped: this.recordSkippedFile(
                            real,
                            {
                                category: 'unapproved root',
                                reason: `${root.path} is not an approved memory root; skipped before parsing transcript content. Grant it with \`elepha consent grant ${root.path}\`.`,
                            },
                            logContext,
                        ),
                    };
                }
            }

            if (this.store.isTranscriptCaptureBlocked(adapter.tool, nativeId)) {
                return {
                    ingested: 0,
                    skipped: this.recordSkippedFile(real, this.blockedTranscriptSkip(adapter.tool, nativeId), logContext),
                };
            }
            if (this.store.isTranscriptIncognito(adapter.tool, nativeId)) {
                return {
                    ingested: 0,
                    skipped: this.recordSkippedFile(
                        real,
                        {
                            category: 'incognito',
                            reason: `transcript ${nativeId} was observed while capture was denied and is permanently excluded from ingestion`,
                        },
                        logContext,
                    ),
                };
            }

            const classification = await adapter.classifySession(real, { handle });
            this.kindCache.set(real, classification);
            const skipLabel =
                classification.exclusion ??
                (classification.kind === 'fork-copy' || classification.kind === 'adjudicator' ? classification.kind : undefined);
            if (skipLabel) {
                return {
                    ingested: 0,
                    skipped: this.recordSkippedFile(
                        real,
                        {
                            category: 'excluded session',
                            reason: `skipping ${skipLabel} session ${path.basename(real)}: ${classification.reason ?? ''}`,
                        },
                        logContext,
                    ),
                };
            }

            // custom-title is standalone Claude Code UI metadata. Reading it
            // separately keeps the turn parser and rendered output byte-neutral.
            const sourceMetadata = await adapter.readSourceMetadata?.(real);
            const customTitle = sourceMetadata?.customTitle ?? (await this.readCustomTitle(adapter, real));
            let validateSource: (() => boolean) | undefined;
            const validateOpenTurnSource = sourceSnapshotValidator(adapter.tool, filePath, opened);
            let retracted = 0;
            const storedResume = this.store.getSessionResume(adapter.tool, nativeId);
            const storedCursor = storedResume?.cursor;
            let reconcile = false;
            if (adapter.retractable) {
                const validateWire = sourceSnapshotValidator(adapter.tool, filePath, opened);
                validateSource = () => validateWire() && sourceMetadata?.validate() === true && sourceMetadata.cwd === metadata.cwd;
                reconcile = (await adapter.needsReconciliation?.(real, storedCursor, handle)) ?? true;
                if (reconcile) {
                    const reconciliation = new SourceReconciliation(this.store, adapter.tool, nativeId, metadata.cwd, validateSource);
                    for await (const turn of adapter.parseTurns(real, undefined, { handle })) {
                        reconciliation.observe(turn);
                    }
                    retracted = reconciliation.commit();
                    if (retracted > 0) {
                        this.log(
                            formatDaemonLog(`[elepha] reconciled source: removed ${retracted} changed or retracted turns`, logContext),
                        );
                    }
                }
            }
            const cursor = reconcile ? undefined : storedCursor;
            let resumeContext: ResumeContext | undefined;
            if (cursor !== undefined) {
                const stored = storedResume?.context;
                const resumeKey = `${adapter.tool}:${nativeId}`;
                if (!adapter.carriesContextAcrossTurns || (stored !== undefined && adapter.resumeContextComplete?.(stored) === true)) {
                    resumeContext = stored;
                    this.resumeReconstructions.delete(resumeKey);
                } else {
                    // A cursor stored without a complete context. It stays where
                    // it is until a bounded reconstruction from the source
                    // completes; each unfinished step queues the next.
                    resumeContext = await this.reconstructResumeContext(adapter, handle, cursor, resumeKey, logContext);
                    if (resumeContext === undefined) {
                        if (!this.stopping) {
                            this.workQueue.enqueue(async () => {
                                await this.scanFile(adapter, filePath, closeTrailingOnIdle, onlyProjectRoots);
                            });
                        }
                        return { ingested: 0 };
                    }
                }
            }
            let ingested = 0;
            let parsedTurns = 0;
            let openTail: OpenTailObservation | undefined;
            let malformedRecords: number | undefined;
            let unrecognizedRecords: number | undefined;
            for await (const turn of adapter.parseTurns(real, cursor, {
                closeTrailingOnIdle,
                handle,
                resumeContext,
                onOpenTail: (observation) => {
                    openTail = observation;
                },
                onMalformedRecords: (count) => {
                    malformedRecords = count;
                },
                onUnrecognizedRecords: (count) => {
                    unrecognizedRecords = count;
                },
            })) {
                parsedTurns++;
                turn.validateSource = validateSource;
                const consentState = this.consentStateForTurn(turn);
                if (consentState === 'denied') {
                    this.store.recordIncognitoTranscript(turn.tool, turn.sessionId);
                    break;
                }
                if (turn.droppedReason !== undefined) {
                    await this.advanceDroppedTurn(turn, customTitle);
                    if (this.store.isTranscriptIncognito(turn.tool, turn.sessionId)) {
                        break;
                    }
                    continue;
                }
                if (await this.persistTurn(adapter, turn, customTitle)) {
                    ingested++;
                }
                if (this.store.isTranscriptIncognito(turn.tool, turn.sessionId)) {
                    break;
                }
            }

            // Valid turns beside a skipped record stay stored, but the source
            // is no longer completely captured. Only a stored session has
            // coverage to withdraw; a transcript that is not captured has none.
            this.recordLiveParseGap(adapter.tool, nativeId, { malformed: malformedRecords ?? 0, unrecognized: unrecognizedRecords ?? 0 });

            if (openTail !== undefined) {
                await this.handleOpenTail(
                    adapter,
                    openTail,
                    classification,
                    openTurnGeneration,
                    openTurnSource,
                    validateOpenTurnSource,
                    openTurnValidationEpoch,
                );
            }

            // Mid-task handoff can't wait for session close - that's the whole
            // wedge - so the rollup refreshes as each batch lands, not only at
            // the end. Incremental by construction, so this
            // costs one small merge per batch rather than a full re-summary.
            if (ingested > 0 || retracted > 0) {
                await this.refreshRollup(adapter, real, nativeId, 'live');
            }
            if (
                ingested > 0 &&
                sourceMetadata &&
                validateSource?.() &&
                this.store.consent.consentState(sourceMetadata.cwd) === 'approved'
            ) {
                const stored = this.store.findSession(adapter.tool, nativeId);
                if (stored) {
                    this.store.updateSessionTitle(stored.id, { aiTitle: sourceMetadata.title, userMessage: '' });
                }
            }
            this.skippedFiles.delete(real);
            // A non-empty transcript that parses successfully yet emits no
            // turns means the adapter's expected boundary may have vanished.
            // Alert only before a cursor exists: a steady-state scan with no
            // bytes after its cursor is normal, and a genuinely empty file is
            // not a format-migration signal.
            if (cursor === undefined && parsedTurns === 0 && openTail === undefined && (await handle.stat()).size > 0) {
                const emptySession = await adapter.classifyEmptySession(real);
                if (emptySession) {
                    return { ingested: 0, emptySession: emptySession.kind, malformedRecords, unrecognizedRecords };
                }
                return {
                    ingested: 0,
                    malformedRecords,
                    unrecognizedRecords,
                    skipped: this.recordSkippedFile(
                        real,
                        {
                            category: 'zero parsed turns',
                            reason:
                                'parsed successfully but yielded zero turns - expected user-turn boundary was not found; ' +
                                'no memory rows were written (check the transcript format and update its adapter)',
                        },
                        logContext,
                    ),
                };
            }
            return {
                ingested,
                skipped: ingested === 0 ? this.skippedFiles.get(real) : undefined,
                malformedRecords,
                unrecognizedRecords,
            };
        } catch (err) {
            if (err instanceof OversizedTranscriptRecordError) {
                const skipped = this.quarantineOversizedTranscript(real, err, logContext, fileStat);
                return {
                    ingested: 0,
                    skipped,
                };
            }

            return {
                ingested: 0,
                skipped: this.recordSkippedFile(filePath, this.fileSkipForError(err), logContext),
            };
        } finally {
            this.processing.delete(real);
            await handle.close();
        }
    }

    private recordLiveParseGap(tool: ToolName, nativeId: string, records: { malformed: number; unrecognized: number }): void {
        if (records.malformed + records.unrecognized === 0 || !this.store.findSession(tool, nativeId)) {
            return;
        }
        this.store.database.transaction(() => {
            const capture = new DurableCaptureStore(this.store.database);
            for (const row of this.store.database
                .prepare('SELECT id FROM sessions WHERE tool = ? AND native_id = ?')
                .all(tool, nativeId) as Array<{ id: number }>) {
                capture.setStatus(row.id, 'parse_error', new Date(this.now()).toISOString());
            }
        })();
    }

    private async readCustomTitle(adapter: SessionAdapter, filePath: string): Promise<string | undefined> {
        if (!adapter.readCustomTitle) {
            return undefined;
        }

        const { size, mtimeMs } = await fsStat(filePath);
        const cached = this.customTitleCache.get(filePath);
        if (cached && size === cached.size && mtimeMs === cached.mtimeMs) {
            return cached.customTitle;
        }

        const fromOffset = cached && size >= cached.size && mtimeMs >= cached.mtimeMs ? cached.scannedTo : 0;
        const result = await adapter.readCustomTitle(filePath, fromOffset);
        const customTitle = fromOffset === 0 ? result.customTitle : (result.customTitle ?? cached?.customTitle);
        this.customTitleCache.set(filePath, { size, mtimeMs, scannedTo: result.scannedTo, customTitle });
        return customTitle;
    }

    private async handleOpenTail(
        adapter: SessionAdapter,
        observation: OpenTailObservation,
        classification: SessionClassification,
        sourceGenerationValue: number,
        source: OpenTurnSourceSnapshot,
        validateSource: () => boolean,
        validationEpoch: number,
    ): Promise<void> {
        const turn = observation.receiptCoverage.turn;
        turn.validateSource = validateSource;
        if (!this.isCurrentOpenTurnValidation(turn.tool, turn.sessionId, validationEpoch)) {
            return;
        }
        if (this.store.consent.isRefusedForCapture(turn.projectPath)) {
            return;
        }
        const consentState = this.consentStateForTurn(turn);
        if (consentState === 'denied') {
            this.store.recordIncognitoTranscript(turn.tool, turn.sessionId);
            return;
        }
        if (consentState !== 'approved') {
            return;
        }
        const meta = {
            surface: sessionSurface(turn.tool, turn.surface),
            gitBranch: turn.gitBranch ?? null,
            kind: toSessionRowKind(classification.kind),
        };
        const observedAt = new Date(this.now()).toISOString();
        const staged = this.store.observeOpenTurn(observation, meta, sourceGenerationValue, source, observedAt, validationEpoch);
        if (staged === undefined) {
            return;
        }
        if (observation.receiptCoverage.state === 'incomplete') {
            this.log(
                formatDaemonLog(
                    `[elepha] failed-EOF turn ${turn.turnIndex} not staged: MCP receipt coverage incomplete (${observation.receiptCoverage.reason})`,
                    turn,
                ),
            );
            return;
        }
        if (turn.droppedReason === 'elepha-mcp' || staged.staged_at !== null) {
            return;
        }
        const failedAtMs = Date.parse(observation.failedAt);
        const eligibleAt = (Number.isFinite(failedAtMs) ? failedAtMs : this.now()) + OPEN_TURN_SUMMARY_GRACE_MS;
        const remaining = eligibleAt - this.now();
        if (remaining > 0) {
            this.scheduleOpenTurnScan(adapter, turn.sourcePath, remaining);
            return;
        }

        const summary = this.summarizer
            ? await this.summarizer.summarize({ userMessage: turn.userMessage, assistantText: turn.assistantText })
            : { decisions: [], pending_items: [], status: 'not_configured' as const };
        if (this.summarizer) {
            this.trackOutcome(summary.status);
        }
        if (!validateSource() || sourceGeneration(this.store, turn.tool, turn.sessionId) !== sourceGenerationValue) {
            return;
        }
        const stagedAt = new Date(this.now()).toISOString();
        const projection = retainsFilteredCopy(turn.tool, this.legacyDurableCapture) ? filterTurn(turn) : undefined;
        const inserted = this.store.stageOpenTurnSummary(
            turn.tool,
            turn.sessionId,
            source.revision,
            staged.source_digest,
            summary,
            stagedAt,
            projection,
            turn.projectPath,
            validateSource,
            validationEpoch,
        );
        if (inserted) {
            this.log(formatDaemonLog(`[elepha] staged incomplete failed-EOF turn ${turn.turnIndex}`, turn));
        }
    }

    private async persistTurn(
        adapter: SessionAdapter | SqliteSourceAdapter,
        turn: ParsedTurn,
        customTitle?: string,
        explicitClassification?: SessionClassification,
        // A verified source-format handoff opens its own segment regardless
        // of the gap/branch/file boundary heuristics.
        forceSegment = false,
    ): Promise<boolean> {
        // Refused roots ($HOME itself, document dumps) never become projects.
        // Enforced here rather than downstream because a project row created
        // from a bad cwd is self-healing in the wrong direction: purge it and
        // the next turn from that directory recreates it.
        if (this.store.consent.isRefusedForCapture(turn.projectPath)) {
            this.recordSkippedFile(
                turn.sourcePath,
                {
                    category: 'refused root',
                    reason: `refusing to ingest from "${turn.projectPath || '(empty cwd)'}" - not a permitted project root`,
                },
                turn,
            );
            return false;
        }

        const consentState = this.consentStateForTurn(turn);
        if (consentState === 'denied') {
            this.store.recordIncognitoTranscript(turn.tool, turn.sessionId);
        }
        if (consentState !== 'approved') {
            return false;
        }

        // Quote-back is deliberately before project/session persistence and the
        // summarizer: adapters stay DB-free, while a match must have no memory
        // side effects. The existing session's cursor is the sole exception,
        // otherwise this complete source turn would be re-read forever.
        const quoteBackStatus = this.store.injectionQuoteBackStatus(turn);
        if (quoteBackStatus === 'incomplete') {
            this.log(formatDaemonLog(`[elepha] refused turn ${turn.turnIndex}: self-ingestion protection incomplete`, turn));
            return false;
        }
        if (quoteBackStatus === 'match') {
            // Before a forced handoff segment exists, the only stored cursor
            // belongs to another source format and must not move.
            if (!forceSegment && !this.store.recordQuoteBackTurn(turn)) {
                return false;
            }
            this.log(
                formatDaemonLog(`[elepha] dropped turn ${turn.turnIndex} of ${turn.sessionId}: self-injected content (quote-back)`, turn),
            );
            return false;
        }

        const surface = sessionSurface(turn.tool, turn.surface);
        const classification =
            explicitClassification ??
            this.kindCache.get(turn.sourcePath) ??
            (await this.adapterFor(turn.sourcePath)?.classifySession(turn.sourcePath));
        const meta = {
            surface,
            gitBranch: turn.gitBranch ?? null,
            kind: classification ? toSessionRowKind(classification.kind) : null,
            customTitle,
            sourceFormat: turn.tool === 'opencode' && turn.cursor.startsWith('v2:') ? ('opencode-v2' as const) : ('native' as const),
        };
        const session = this.store.findSession(turn.tool, turn.sessionId);

        // Segmentation precedes both dedupe and soft-final wakeup. The entire
        // comparison comes from this one hydrated session row plus the parsed
        // closed turn; memories/turn history never contributes boundary data.
        const previousEndedAt = Date.parse(session?.last_turn_at ?? '');
        const resumingStartedAt = Date.parse(turn.startedAt);
        const gapHours =
            session?.last_turn_at !== null && Number.isFinite(previousEndedAt) && Number.isFinite(resumingStartedAt)
                ? Math.max(0, resumingStartedAt - previousEndedAt) / (60 * 60 * 1000)
                : 0;
        const cut =
            session !== undefined &&
            (forceSegment ||
                evaluateSegmentBoundary({
                    gapHours,
                    trailingBranch: session.trailing_branch,
                    resumingBranch: turn.gitBranch ?? null,
                    trailingFiles: session.trailing_files,
                    resumingFiles: turn.toolCalls.flatMap((call) => call.filePaths),
                    resumeMarkerBefore: turn.resumeMarkerBefore,
                }));

        // Overlapping watch events (prompt scan + idle scan, or two rapid
        // 'add' events on cold start) can re-present an already-recorded
        // turn. INSERT OR IGNORE makes that safe for the data, but a Haiku
        // call whose result gets discarded is still wasted spend - skip it.
        // The native-wide lookup matters after a cut: session-local UNIQUE
        // cannot tell that this turn index already lives in an older segment.
        // It deliberately runs after the boundary comparison (soft-final's
        // required ordering) and contributes no evidence to that comparison.
        if (this.store.hasMemoryForNativeTurn(turn.tool, turn.sessionId, turn.turnIndex)) {
            if (turn.sourceKey !== undefined) {
                this.store.refreshExistingSourceTurn(turn);
            }
            return false;
        }

        if (cut && session) {
            // Everything already stored in the old segment belongs to it.
            // Finalize before opening the fresh segment so no rollup can ever
            // merge content from opposite sides of the boundary.
            await this.refreshStoredSessionRollup(adapter, turn.sourcePath, session, classification, 'final');
        }

        const reportOnly = turn.taskStateReport !== undefined && !turn.userMessage && !turn.assistantText && turn.toolCalls.length === 0;
        const summary =
            this.summarizer && !reportOnly
                ? await this.summarizer.summarize({ userMessage: turn.userMessage, assistantText: turn.assistantText })
                : { decisions: [], pending_items: [], status: 'not_configured' as const };
        if (this.summarizer && !reportOnly) {
            this.trackOutcome(summary.status);
        }
        // A capacity deferral throws out of the file loop so no later turn can
        // move the cursor past this one; the next scan retries from here.
        const persisted = this.store.recordIngestedTurn(
            turn,
            meta,
            cut,
            summary,
            retainsFilteredCopy(turn.tool, this.legacyDurableCapture),
            undefined,
        );
        if (!persisted) {
            return false;
        }
        const { inserted, project, session: storedSession } = persisted;
        if (inserted) {
            this.log(
                formatDaemonLog(
                    `[elepha] captured turn ${turn.turnIndex} (${adapter.tool}) for ${project.display_name ?? project.path}`,
                    turn,
                ),
            );
            // This happens only AFTER the boundary decision above. On a cut,
            // the new segment starts live; without a cut, a soft-final session
            // wakes and incrementally merges into the same watermark-protected
            // aggregate. Reprocessing the same turn returns before this call,
            // so it cannot spuriously wake or double-merge a final rollup.
            if (this.rollups) {
                this.rollups.markLive(storedSession.id);
            } else {
                this.rollupService?.noteActivity(storedSession.id);
            }
            if (turn.taskStateReport?.mode === 'precompact_manifest') {
                await this.taskStateManifests.publish(turn, storedSession.id);
            }
        }
        return inserted;
    }

    // The adapter has already logged a sentinel match and intentionally did
    // not emit a persistable turn. We still create/locate its ordinary session
    // so its cursor can move past the complete source range without recording
    // memory, rendered stats, boundary state, or a summarizer call.
    private async advanceDroppedTurn(
        turn: ParsedTurn,
        customTitle?: string,
        explicitClassification?: SessionClassification,
    ): Promise<void> {
        if (this.store.consent.isRefusedForCapture(turn.projectPath)) {
            this.recordSkippedFile(
                turn.sourcePath,
                {
                    category: 'refused root',
                    reason: `refusing to ingest from "${turn.projectPath || '(empty cwd)'}" - not a permitted project root`,
                },
                turn,
            );
            return;
        }
        const consentState = this.consentStateForTurn(turn);
        if (consentState === 'denied') {
            this.store.recordIncognitoTranscript(turn.tool, turn.sessionId);
        }
        if (consentState !== 'approved') {
            return;
        }

        const classification =
            explicitClassification ??
            this.kindCache.get(turn.sourcePath) ??
            (await this.adapterFor(turn.sourcePath)?.classifySession(turn.sourcePath));
        const meta = {
            surface: sessionSurface(turn.tool, turn.surface),
            gitBranch: turn.gitBranch ?? null,
            kind: classification ? toSessionRowKind(classification.kind) : null,
            customTitle,
            sourceFormat: turn.tool === 'opencode' && turn.cursor.startsWith('v2:') ? ('opencode-v2' as const) : ('native' as const),
        };
        if (!this.store.recordDroppedTurn(turn, meta)) {
            return;
        }
        if (turn.droppedReason === 'elepha-mcp') {
            this.log(formatDaemonLog(`[elepha] dropped turn ${turn.turnIndex} of ${turn.sessionId}: Elepha MCP output`, turn));
        }
    }

    // Turn-level consent fallback behind the file-level gate in scanFile. A
    // later pending cwd is dropped without creating a pending root (that
    // decision belongs to the first cwd) and is logged once per transcript and
    // cwd. A denied cwd is returned distinctly so callers can permanently veto
    // the native session and stop before advancing beyond the denied turn.
    private consentStateForTurn(turn: ParsedTurn): ConsentState {
        const state = this.store.consent.consentState(turn.projectPath);
        if (state === 'pending') {
            this.warnDeduplicated(
                formatDaemonLog(
                    `[elepha] dropped turn(s) of ${turn.sourcePath}: cwd "${turn.projectPath}" is outside every approved root; not persisted (grant a covering root with \`elepha consent grant <path>\`)`,
                    turn,
                ),
            );
        }
        return state;
    }

    // Recomputes a session's rollup. `state` is 'live' for a mid-session batch
    // and 'final' once the transcript has gone idle - but 'final' is only ever
    // a heuristic, and any later turn returns the session to 'live'.
    private async refreshRollup(
        adapter: SessionAdapter | SqliteSourceAdapter,
        filePath: string,
        nativeId: string,
        state: 'live' | 'final',
        explicitClassification?: SessionClassification,
    ): Promise<void> {
        if (!this.rollupService || isMemoryLocked(this.store.database)) {
            return;
        }

        const session = this.store.findSession(adapter.tool, nativeId);
        if (!session || !isSessionKindEligible(this.store.database, session.id)) {
            return;
        }

        const classification =
            explicitClassification ?? this.kindCache.get(filePath) ?? (await (adapter as SessionAdapter).classifySession(filePath));
        await this.refreshStoredSessionRollup(adapter, filePath, session, classification, state);
    }

    private async refreshStoredSessionRollup(
        adapter: SessionAdapter | SqliteSourceAdapter,
        filePath: string,
        session: NonNullable<ReturnType<MemoryStore['findSession']>>,
        classification: SessionClassification | undefined,
        state: 'live' | 'final',
    ): Promise<void> {
        if (!this.rollupService || isMemoryLocked(this.store.database) || !isSessionKindEligible(this.store.database, session.id)) {
            return;
        }

        const resolvedClassification =
            classification ?? this.kindCache.get(filePath) ?? (await (adapter as SessionAdapter).classifySession(filePath));
        const kind = resolvedClassification.kind;
        // Sub-agent work is attached to the parent session rather than listed
        // as a peer; an un-ingested parent leaves it standalone rather than
        // orphaning it out of every listing.
        const parentSessionId = resolvedClassification.parentNativeId
            ? (this.store.findSession(adapter.tool, resolvedClassification.parentNativeId)?.id ?? null)
            : null;

        try {
            await this.rollupService.rollupSession(session, kind, parentSessionId, state);
        } catch (err) {
            this.logError(
                formatDaemonLog(`[elepha] rollup failed for ${session.native_id}: ${(err as Error).message}`, {
                    tool: session.tool,
                    sessionId: session.native_id,
                }),
            );
        }
    }

    // Closes sessions whose transcripts have gone quiet, including those that
    // ended while the daemon was down - without this startup sweep, a session
    // that finished during downtime would sit 'live' forever, since no further
    // file event will ever arrive for it.
    async sweepIdleSessions(now = Date.now()): Promise<number> {
        if (!this.rollupService || isMemoryLocked(this.store.database)) {
            return 0;
        }
        let closed = 0;
        for (const session of this.store.listOpenSessions()) {
            // Capture-only history has no synthesis output to aggregate.
            // An idle sweep must not turn discovery into a provider call.
            // A later summarized live turn makes this session eligible again.
            if (
                (session.tool === 'claude-code' || session.tool === 'codex') &&
                this.store.database
                    .prepare("SELECT 1 FROM memories WHERE session_id = ? AND summarizer_status <> 'not_configured' LIMIT 1")
                    .get(session.id) === undefined
            ) {
                continue;
            }
            const adapter = this.adapters.find((a) => a.tool === session.tool);
            if (!adapter) {
                continue;
            }
            if (!isReadableProviderSource(session.tool, session.source_path)) {
                continue;
            }
            const stat = await fsStat(session.source_path).catch(() => undefined);
            if (!stat || !this.rollupService.isIdle(stat.mtimeMs, now) || !isSessionKindEligible(this.store.database, session.id)) {
                continue;
            }
            try {
                await this.refreshRollup(adapter, session.source_path, session.native_id, 'final');
            } catch (error) {
                if (error instanceof OversizedTranscriptRecordError) {
                    this.quarantineOversizedTranscript(
                        session.source_path,
                        error,
                        { tool: session.tool, sessionId: session.native_id },
                        { size: stat.size, mtimeMs: stat.mtimeMs },
                    );
                    continue;
                }
                throw error;
            }
            closed++;
        }
        if (closed > 0) {
            this.log(`[elepha] closed ${closed} idle session(s)`);
        }
        return closed;
    }

    private trackOutcome(status: SummarizerStatus): void {
        this.failureWindow.trackOutcome(status);
    }
}
