// Ingestion daemon: watches Claude Code / Codex session paths, feeds new turns
// through adapters and writes structural capture into storage. Provider-backed
// extraction and rollups are optional work layered on top.
//
// Every file change triggers two kinds of scan:
//  - a prompt scan (closeTrailingOnIdle: false) - picks up any turn that
//    already closed via a following boundary line, without waiting;
//  - a debounced idle scan (closeTrailingOnIdle: true), fired once the file
//    has gone quiet for idleDebounceMs - flushes a trailing turn that never
//    got a following boundary line (e.g. the session is still open).
// Both go through a bounded concurrency queue: cost per summarization call is
// negligible, but several projects writing at once are not, and without a
// per-file mutex a second scan could re-read a cursor the first is still
// advancing.

import { stat as fsStat, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import chokidar, { type FSWatcher } from 'chokidar';
import { OversizedTranscriptRecordError } from '../adapters/base.js';
import { ClaudeCodeAdapter } from '../adapters/claude-code.js';
import { CodexAdapter } from '../adapters/codex.js';
import { claudeCodeSurface, codexSurface, toSessionRowKind } from '../adapters/discriminators.js';
import {
    DEFAULT_IDLE_DEBOUNCE_MS,
    DEFAULT_MAX_CONCURRENT,
    HEARTBEAT_INTERVAL_MS,
    MAX_DAEMON_UNKNOWN_LINE_WARNINGS,
    SWEEP_INTERVAL_MS,
    UPDATE_CHECK_LOOP_INTERVAL_MS,
} from '../config/constants.js';
import { readMemoryConfig } from '../config/memory-config.js';
import {
    canonicalizeExisting,
    claudeProjectsRoot,
    codexSessionsRoot,
    daemonStderrLogPath,
    daemonStdoutLogPath,
    isReadableProviderSource,
    isRefusedProjectRoot,
    isWithin,
    updateAvailablePath,
    updateCheckStatePath,
} from '../config/paths.js';
import { readSessionMetadata } from '../discovery/session-projects.js';
import { installedAndLatestElephaVersionAsync } from '../install/self-update.js';
import { openProviderTranscript, type ProviderTranscriptOpener } from '../security/provider-transcript.js';
import { isNearVerbatim, turnText } from '../security/self-ingestion.js';
import type { ConsentState } from '../storage/consent-store.js';
import { openDb } from '../storage/db.js';
import { MemoryStore } from '../storage/memory-store.js';
import type { RollupStore } from '../storage/rollup-store.js';
import { evaluateSegmentBoundary } from '../storage/segmentation.js';
import type {
    EmptySessionKind,
    ParsedTurn,
    SessionAdapter,
    SessionClassification,
    SummarizationProvider,
    SummarizerStatus,
} from '../types/index.js';
import { FailureWindow } from './failure-window.js';
import { clearHeartbeat, defaultHeartbeatPath, writeHeartbeat } from './heartbeat.js';
import { type DaemonLogPaths, rotateDaemonLogs } from './log-rotation.js';
import { type FileSkip, type FileSkipCategory, ReadabilityGuard } from './readability-guard.js';
import type { RollupService } from './rollup-service.js';
import { runUpdateCheck, updateCheckEnabled } from './update-check.js';
import { WorkQueue } from './work-queue.js';

interface ScanResult {
    ingested: number;
    skipped?: FileSkip;
    emptySession?: EmptySessionKind;
}

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
]);

// How often to look for sessions that have gone quiet. Well under the idle
// threshold so a closed session rolls up promptly rather than up to a full
// threshold late.

/**
 * A format change can create one unknown line per transcript record. Keep the
 * daemon log useful by emitting each distinct adapter message once, while a
 * bounded FIFO prevents a long-lived process from retaining unbounded keys.
 */
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
    return [claudeProjectsRoot(), codexSessionsRoot()];
}

export interface DaemonOptions {
    store?: MemoryStore;
    summarizer?: SummarizationProvider;
    adapters?: SessionAdapter[];
    idleDebounceMs?: number;
    maxConcurrentSummaries?: number;
    log?: (msg: string) => void;
    logError?: (msg: string) => void;
    /** Overrides the watched root directories. Defaults to the real ~/.claude/projects and ~/.codex/sessions; tests point this at a temp dir. */
    watchRoots?: string[];
    /** Overrides the heartbeat file path (see ./heartbeat.ts). Defaults to ~/.elepha/daemon.heartbeat.json; tests point this at a temp file. */
    heartbeatPath?: string;
    /** Test seam for launchd-managed logs. Production uses the canonical ~/.elepha/logs paths. */
    daemonLogPaths?: DaemonLogPaths;
    /** Session rollups. Omit to disable rollups entirely (tests that only exercise turn ingestion). */
    rollupService?: RollupService;
    /** Mechanical rollup state only: capture-only activity reopens an existing final rollup without synthesizing it. */
    rollups?: Pick<RollupStore, 'markLive'>;
    /** How often to sweep for sessions gone idle. Defaults to SWEEP_INTERVAL_MS. */
    sweepIntervalMs?: number;
    /** Test seam for the daemon-owned registry check. The hook never uses it. */
    updateCheck?: () => Promise<unknown> | unknown;
    /** How often to revisit the persisted 24-hour update-check cache. */
    updateCheckIntervalMs?: number;
    /**
     * Forces chokidar to poll instead of using native OS watch descriptors
     * (fsevents on macOS, inotify on Linux). Off by default - native watching
     * is cheaper and this changes real filesystem-event behavior, so it's not
     * something to flip in production. Exists for test environments whose
     * sandbox restricts the underlying `watch` syscall itself (distinct from
     * the process fd ulimit - polling never calls it, it just stats on an
     * interval). See test/daemon and test/security's daemon-backed tests.
     */
    watcherUsePolling?: boolean;
    /** Poll interval in ms when watcherUsePolling is set. Defaults to 50ms. */
    watcherPollIntervalMs?: number;
    /** Reads capture preferences once at daemon startup; tests inject resolved values. */
    readConfig?: typeof readMemoryConfig;
    /** Test seam for counting corpus walks without changing filesystem traversal. */
    readCorpus?: (watchRoot: string) => Promise<string[]>;
    /** Test seam for deterministically exercising opened-object containment races. */
    openTranscript?: ProviderTranscriptOpener;
}

function formatDaemonLog(message: string, context: { tool?: string; sessionId?: string } = {}): string {
    const fields = [context.tool && `tool=${context.tool}`, context.sessionId && `session_id=${context.sessionId}`].filter(Boolean);
    return fields.length === 0 ? message : `${message} ${fields.join(' ')}`;
}

export class IngestionDaemon {
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
    private readonly watcherUsePolling: boolean;
    private readonly watcherPollIntervalMs: number;
    private readonly captureClaudeCode: boolean;
    private readonly captureCodex: boolean;
    private readonly readCorpus: (watchRoot: string) => Promise<string[]>;
    private readonly openTranscript: ProviderTranscriptOpener;
    private sweepTimer: NodeJS.Timeout | undefined;
    private initialUpdateCheckTimer: NodeJS.Timeout | undefined;
    private updateCheckTimer: NodeJS.Timeout | undefined;
    private readonly startedAt = new Date().toISOString();

    private watcher: FSWatcher | undefined;
    private heartbeatTimer: NodeJS.Timeout | undefined;
    private readonly idleTimers = new Map<string, NodeJS.Timeout>();
    private readonly processing = new Set<string>();
    private readonly workQueue: WorkQueue;
    private stopPromise: Promise<void> | undefined;
    private signalHandlersInstalled = false;
    private readonly shutdownOnSignal = () => {
        void this.stop().catch((error: unknown) => this.logError(`[elepha] shutdown failed: ${(error as Error).message}`));
    };

    /** Shared with the adapters' unknown-line warnings: one log line per distinct message, bounded FIFO. */
    private readonly warnDeduplicated: (message: string) => void;
    private readonly failureWindow: FailureWindow;
    private readonly skippedFiles = new Map<string, FileSkip>();
    private readonly oversizedFileSkipCache = new Map<string, { size: number; mtimeMs: number; skipped: FileSkip }>();
    private readonly readabilityGuard = new ReadabilityGuard();
    /** Classification per transcript file, so the rollup path doesn't re-read session_meta on every batch. */
    private readonly kindCache = new Map<string, SessionClassification>();
    private readonly customTitleCache = new Map<
        string,
        { size: number; mtimeMs: number; scannedTo: number; customTitle: string | undefined }
    >();

    constructor(options: DaemonOptions = {}) {
        this.log = options.log ?? (() => {});
        this.logError = options.logError ?? console.error;
        const configResult = (options.readConfig ?? readMemoryConfig)();
        if ('error' in configResult) {
            throw new Error(`cannot start daemon: ${configResult.error}`);
        }
        this.captureClaudeCode = configResult.config.captureClaudeCode ?? true;
        this.captureCodex = configResult.config.captureCodex ?? true;
        this.store = options.store ?? new MemoryStore(openDb());
        this.openTranscript = options.openTranscript ?? openProviderTranscript;
        this.summarizer = options.summarizer;
        const warnUnknownLine = deduplicateDaemonUnknownLineWarnings(this.log);
        this.warnDeduplicated = warnUnknownLine;
        this.adapters = options.adapters ?? [new ClaudeCodeAdapter(warnUnknownLine), new CodexAdapter(warnUnknownLine)];
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
        this.watcherUsePolling = options.watcherUsePolling ?? false;
        this.watcherPollIntervalMs = options.watcherPollIntervalMs ?? 50;
        this.readCorpus = options.readCorpus ?? ((watchRoot) => readdir(watchRoot, { recursive: true }));
    }

    start(): void {
        this.installSignalHandlers();
        rotateDaemonLogs(this.daemonLogPaths);
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

        void this.sweepStartupFiles();

        writeHeartbeat(this.heartbeatPath, this.startedAt);
        this.heartbeatTimer = setInterval(() => writeHeartbeat(this.heartbeatPath, this.startedAt), HEARTBEAT_INTERVAL_MS);
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

        if (this.rollupService) {
            // Startup sweep: sessions that ended while the daemon was down will
            // never produce another file event, so nothing else would ever
            // close them.
            void this.sweepIdleSessions().catch((err: unknown) =>
                this.logError(`[elepha] startup sweep failed: ${(err as Error).message}`),
            );
            this.sweepTimer = setInterval(() => {
                void this.sweepIdleSessions().catch((err: unknown) => this.logError(`[elepha] sweep failed: ${(err as Error).message}`));
            }, this.sweepIntervalMs);
            this.sweepTimer.unref();
        }
    }

    async stop(): Promise<void> {
        if (this.stopPromise) {
            return this.stopPromise;
        }
        this.stopPromise = this.stopInternal();
        return this.stopPromise;
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
        if (this.sweepTimer) {
            clearInterval(this.sweepTimer);
        }
        if (this.initialUpdateCheckTimer) {
            clearTimeout(this.initialUpdateCheckTimer);
        }
        if (this.updateCheckTimer) {
            clearInterval(this.updateCheckTimer);
        }
        clearHeartbeat(this.heartbeatPath);
        for (const timer of this.idleTimers.values()) {
            clearTimeout(timer);
        }
        this.idleTimers.clear();
        await this.watcher?.close();
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
        const adapter = this.adapterFor(filePath);
        if (!adapter) {
            return;
        }

        this.enqueueScan(adapter, filePath, false);

        this.scheduleIdleScan(adapter, filePath);
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

    /**
     * Replays local transcripts for one newly-approved root without enabling a
     * synthesis provider. Approval must make the already-written transcript
     * useful, but it must not turn a CLI acknowledgement into unbounded API
     * spend. The normal daemon will continue with provider work on new turns.
     */
    async backfillApprovedRoot(root: string): Promise<number> {
        return this.backfillApprovedRoots([root]);
    }

    /** Replays the provider corpus once for every newly-approved root in the set. */
    async backfillApprovedRoots(roots: string[]): Promise<number> {
        const canonicalRoots = [...new Set(roots.map((root) => canonicalizeExisting(root)))];
        if (canonicalRoots.length === 0) {
            return 0;
        }
        let ingested = 0;
        for (const watchRoot of this.watchRoots) {
            const files = await this.readCorpus(watchRoot).catch(() => [] as string[]);
            for (const relativePath of files.sort()) {
                const filePath = path.join(watchRoot, relativePath);
                const adapter = this.adapterFor(filePath);
                if (adapter) {
                    ingested += (await this.scanFile(adapter, filePath, true, canonicalRoots)).ingested;
                }
            }
        }
        return ingested;
    }

    /**
     * Cold-start work is intentionally an ordered, awaited sweep rather than
     * unbounded initial watch events. scanFile() is its file boundary: one
     * bad transcript reports a skip and cannot prevent a later one from being
     * read.
     */
    private async sweepStartupFiles(): Promise<void> {
        const summary: SweepSummary = { files: 0, ingested: 0, skipped: new Map(), emptySessions: new Map() };
        for (const watchRoot of this.watchRoots) {
            const files = await this.readCorpus(watchRoot).catch((err: unknown) => {
                this.logError(`[elepha] startup sweep could not list ${watchRoot}: ${(err as Error).message}`);
                return [] as string[];
            });
            for (const relativePath of files.sort()) {
                const filePath = path.join(watchRoot, relativePath);
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
                this.scheduleIdleScan(adapter, filePath);
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
            const nativeId = adapter.nativeSessionId(real);
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
                if (isRefusedProjectRoot(metadata.cwd)) {
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

            if (this.store.isTranscriptPurged(adapter.tool, nativeId)) {
                return {
                    ingested: 0,
                    skipped: this.recordSkippedFile(
                        real,
                        {
                            category: 'purged',
                            reason: `transcript ${nativeId} was purged and is permanently excluded from ingestion`,
                        },
                        logContext,
                    ),
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
            const customTitle = await this.readCustomTitle(adapter, real);
            const cursor = this.store.getSessionCursor(adapter.tool, nativeId);
            let ingested = 0;
            let parsedTurns = 0;
            for await (const turn of adapter.parseTurns(real, cursor, { closeTrailingOnIdle, handle })) {
                parsedTurns++;
                const consentState = this.consentStateForTurn(turn);
                if (consentState === 'denied') {
                    this.store.recordIncognitoTranscript(turn.tool, turn.sessionId);
                    break;
                }
                if (turn.droppedReason === 'sentinel') {
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

            // Mid-task handoff can't wait for session close - that's the whole
            // wedge - so the rollup refreshes as each batch lands, not only at
            // the end. Incremental by construction (see RollupService), so this
            // costs one small merge per batch rather than a full re-summary.
            if (ingested > 0) {
                await this.refreshRollup(adapter, real, nativeId, 'live');
            }
            this.skippedFiles.delete(real);
            // A non-empty transcript that parses successfully yet emits no
            // turns means the adapter's expected boundary may have vanished.
            // Alert only before a cursor exists: a steady-state scan with no
            // bytes after its cursor is normal, and a genuinely empty file is
            // not a format-migration signal.
            if (cursor === undefined && parsedTurns === 0 && (await handle.stat()).size > 0) {
                const emptySession = await adapter.classifyEmptySession(real);
                if (emptySession) {
                    return { ingested: 0, emptySession: emptySession.kind };
                }
                return {
                    ingested: 0,
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
            return { ingested, skipped: ingested === 0 ? this.skippedFiles.get(real) : undefined };
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
                skipped: this.recordSkippedFile(
                    filePath,
                    {
                        category: 'unexpected error',
                        reason: `unexpected error: ${(err as Error).message}`,
                    },
                    logContext,
                ),
            };
        } finally {
            this.processing.delete(real);
            await handle.close();
        }
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

    private async persistTurn(adapter: SessionAdapter, turn: ParsedTurn, customTitle?: string): Promise<boolean> {
        // Refused roots ($HOME itself, document dumps) never become projects.
        // Enforced here rather than downstream because a project row created
        // from a bad cwd is self-healing in the wrong direction: purge it and
        // the next turn from that directory recreates it.
        if (isRefusedProjectRoot(turn.projectPath)) {
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
        const injections = this.store.injectionsForSession(turn.tool, turn.sessionId, turn.startedAt);
        if (injections.some((injection) => isNearVerbatim(turnText(turn), injection.body))) {
            this.store.advanceExistingSessionCursor(turn.tool, turn.sessionId, turn.cursor);
            this.log(
                formatDaemonLog(`[elepha] dropped turn ${turn.turnIndex} of ${turn.sessionId}: self-injected content (quote-back)`, turn),
            );
            return false;
        }

        const surface = turn.tool === 'claude-code' ? claudeCodeSurface(turn.surface) : codexSurface(turn.surface);
        const classification =
            this.kindCache.get(turn.sourcePath) ?? (await this.adapterFor(turn.sourcePath)?.classifySession(turn.sourcePath));
        const meta = {
            surface,
            gitBranch: turn.gitBranch ?? null,
            kind: classification ? toSessionRowKind(classification.kind) : null,
            customTitle,
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
            evaluateSegmentBoundary({
                gapHours,
                trailingBranch: session.trailing_branch,
                resumingBranch: turn.gitBranch ?? null,
                trailingFiles: session.trailing_files,
                resumingFiles: turn.toolCalls.flatMap((call) => call.filePaths),
                resumeMarkerBefore: turn.resumeMarkerBefore,
            });

        // Overlapping watch events (prompt scan + idle scan, or two rapid
        // 'add' events on cold start) can re-present an already-recorded
        // turn. INSERT OR IGNORE makes that safe for the data, but a Haiku
        // call whose result gets discarded is still wasted spend - skip it.
        // The native-wide lookup matters after a cut: session-local UNIQUE
        // cannot tell that this turn index already lives in an older segment.
        // It deliberately runs after the boundary comparison (soft-final's
        // required ordering) and contributes no evidence to that comparison.
        if (this.store.hasMemoryForNativeTurn(turn.tool, turn.sessionId, turn.turnIndex)) {
            return false;
        }

        if (cut && session) {
            // Everything already stored in the old segment belongs to it.
            // Finalize before opening the fresh segment so no rollup can ever
            // merge content from opposite sides of the boundary.
            await this.refreshStoredSessionRollup(adapter, turn.sourcePath, session, classification, 'final');
        }

        const summary = this.summarizer
            ? await this.summarizer.summarize({ userMessage: turn.userMessage, assistantText: turn.assistantText })
            : { decisions: [], pending_items: [], status: 'not_configured' as const };
        if (this.summarizer) {
            this.trackOutcome(summary.status);
        }
        const persisted = this.store.recordIngestedTurn(turn, meta, cut, summary);
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
        }
        return inserted;
    }

    /**
     * The adapter has already logged a sentinel match and intentionally did
     * not emit a persistable turn. We still create/locate its ordinary session
     * so its cursor can move past the complete source range without recording
     * memory, rendered stats, boundary state, or a summarizer call.
     */
    private async advanceDroppedTurn(turn: ParsedTurn, customTitle?: string): Promise<void> {
        if (isRefusedProjectRoot(turn.projectPath)) {
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
            this.kindCache.get(turn.sourcePath) ?? (await this.adapterFor(turn.sourcePath)?.classifySession(turn.sourcePath));
        const meta = {
            surface: turn.tool === 'claude-code' ? claudeCodeSurface(turn.surface) : codexSurface(turn.surface),
            gitBranch: turn.gitBranch ?? null,
            kind: classification ? toSessionRowKind(classification.kind) : null,
            customTitle,
        };
        if (!this.store.recordDroppedTurn(turn, meta)) {
            return;
        }
    }

    /**
     * Turn-level consent fallback behind the file-level gate in scanFile. A
     * later pending cwd is dropped without creating a pending root (that
     * decision belongs to the first cwd) and is logged once per transcript and
     * cwd. A denied cwd is returned distinctly so callers can permanently veto
     * the native session and stop before advancing beyond the denied turn.
     */
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

    /**
     * Recomputes a session's rollup. `state` is 'live' for a mid-session batch
     * and 'final' once the transcript has gone idle - but 'final' is only ever
     * a heuristic, and any later turn returns the session to 'live'.
     */
    private async refreshRollup(adapter: SessionAdapter, filePath: string, nativeId: string, state: 'live' | 'final'): Promise<void> {
        if (!this.rollupService) {
            return;
        }

        const session = this.store.findSession(adapter.tool, nativeId);
        if (!session) {
            return;
        }

        const classification = this.kindCache.get(filePath) ?? (await adapter.classifySession(filePath));
        await this.refreshStoredSessionRollup(adapter, filePath, session, classification, state);
    }

    private async refreshStoredSessionRollup(
        adapter: SessionAdapter,
        filePath: string,
        session: NonNullable<ReturnType<MemoryStore['findSession']>>,
        classification: SessionClassification | undefined,
        state: 'live' | 'final',
    ): Promise<void> {
        if (!this.rollupService) {
            return;
        }

        const resolvedClassification = classification ?? this.kindCache.get(filePath) ?? (await adapter.classifySession(filePath));
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

    /**
     * Closes sessions whose transcripts have gone quiet, including those that
     * ended while the daemon was down - without this startup sweep, a session
     * that finished during downtime would sit 'live' forever, since no further
     * file event will ever arrive for it.
     */
    async sweepIdleSessions(now = Date.now()): Promise<number> {
        if (!this.rollupService) {
            return 0;
        }
        let closed = 0;
        for (const session of this.store.listOpenSessions()) {
            const adapter = this.adapters.find((a) => a.tool === session.tool);
            if (!adapter) {
                continue;
            }
            if (!isReadableProviderSource(session.tool, session.source_path)) {
                continue;
            }
            const stat = await fsStat(session.source_path).catch(() => undefined);
            if (!stat || !this.rollupService.isIdle(stat.mtimeMs, now)) {
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
