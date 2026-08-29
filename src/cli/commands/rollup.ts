import { stat as statFile } from 'node:fs/promises';
import type { Command } from 'commander';
import { ClaudeCodeAdapter } from '../../adapters/claude-code.js';
import { CodexAdapter } from '../../adapters/codex.js';
import { CHARS_PER_TOKEN } from '../../config/constants.js';
import { isReadableProviderSource } from '../../config/paths.js';
import { RollupService } from '../../daemon/rollup-service.js';
import { daemonHealth } from '../../install/health-checks.js';
import { openDb } from '../../storage/db.js';
import { MemoryStore, type SessionRow } from '../../storage/memory-store.js';
import { ROLLUP_VERSION, RollupStore } from '../../storage/rollup-store.js';
import { SummarizerCallLog } from '../../summarizer/call-log.js';
import { estimateCostUsd } from '../../summarizer/pricing.js';
import { createConfiguredSynthesisProviders } from '../../summarizer/provider-config.js';
import type { SessionAdapter, ToolName } from '../../types/index.js';

const REBUILD_PREVIEW_OUTPUT_TOKENS_PER_SESSION = 512;

export function registerRollup(program: Command): void {
    program
        .command('rollup', { hidden: true })
        .description('Compute session rollups for sessions that do not have an up-to-date one. Safe to re-run: incremental and idempotent.')
        .option('--all', 'include sessions whose transcript is still active (default: only sessions idle past the close threshold)')
        .option(
            '--rebuild',
            'rebuild every rollup written by an older rollup_version, including finalized ones. Without this, only open sessions are visited, so a version bump silently misses every final rollup.',
        )
        .option('--apply', 'run a --rebuild after showing its estimated cost')
        .option('--limit <n>', 'stop after N sessions', '0')
        .action(async (opts: { all: boolean; rebuild: boolean; apply: boolean; limit: string }) => {
            let store: MemoryStore | undefined;
            let candidates: SessionRow[] | undefined;
            // A multi-batch rebuild reprocesses a session from scratch across
            // several model calls; the live daemon's own idle-sweep or
            // new-turn-triggered rollupSession call can land on the same session
            // in between those batches and move the watermark out from under it.
            // The watermark guard then correctly refuses the rebuild's next
            // write, but only after that batch's API call has already been
            // paid for. Refusing outright beats racing (the incident this guards
            // against: 9 of 10 sessions aborted this way in one run, $1.66 spent
            // for no progress).
            if (opts.rebuild) {
                const rebuildStore = new MemoryStore(openDb());
                store = rebuildStore;
                candidates = rebuildStore.listSessionsForRollupRebuild(ROLLUP_VERSION);
                if (!opts.apply) {
                    const inputTokens = candidates.reduce(
                        (sum, session) =>
                            sum +
                            (session.rendered_chars === null
                                ? rebuildStore.listMemoriesForSession(session.id).length
                                : Math.ceil(session.rendered_chars / CHARS_PER_TOKEN)),
                        0,
                    );
                    const outputTokens = candidates.length * REBUILD_PREVIEW_OUTPUT_TOKENS_PER_SESSION;
                    console.log(`Preview: ${candidates.length} session(s) would be rebuilt whose rollup predates v${ROLLUP_VERSION}.`);
                    console.log(
                        `ESTIMATED cost: $${estimateCostUsd(inputTokens, outputTokens).toFixed(4)} (${inputTokens} input / ${outputTokens} output tokens).`,
                    );
                    console.log('Re-run with --rebuild --apply to make API calls.');
                    return;
                }
                const { state, healthy } = daemonHealth();
                if (healthy) {
                    console.error(`Refusing to run --rebuild while the daemon is live (${state}).`);
                    console.error('Run `elepha pause`, then re-run `elepha rollup --rebuild --apply`, and finish with `elepha resume`.');
                    process.exitCode = 1;
                    return;
                }
            }

            const providers = createConfiguredSynthesisProviders();
            if (!providers) {
                console.error('No synthesis provider configured. Set ANTHROPIC_API_KEY before running rollup.');
                process.exitCode = 1;
                return;
            }
            const activeStore = store ?? new MemoryStore(openDb());
            const rollups = new RollupStore(activeStore.database);
            const callLog = new SummarizerCallLog();
            const service = new RollupService({
                store: activeStore,
                rollups,
                provider: providers.rollupMerge,
                log: (msg) => console.log(msg),
            });
            const adapters: Record<ToolName, SessionAdapter> = { 'claude-code': new ClaudeCodeAdapter(), codex: new CodexAdapter() };

            const limit = Number(opts.limit) || 0;
            const runStart = new Date().toISOString();
            let completed = 0;
            let aborted = 0;
            let skipped = 0;

            // --rebuild widens the set to every stale-version rollup. The default
            // sweep deliberately skips `final` rollups, which is correct for
            // idle-close and wrong for a version bump.
            const sessions = candidates ?? activeStore.listOpenSessions();
            if (opts.rebuild) {
                console.log(`Rebuilding ${sessions.length} session(s) whose rollup predates v${ROLLUP_VERSION}.`);
            }

            for (const session of sessions) {
                if (limit && completed + aborted >= limit) {
                    break;
                }
                const adapter = adapters[session.tool];
                if (!isReadableProviderSource(session.tool, session.source_path)) {
                    continue;
                }
                const stat = await statFile(session.source_path).catch(() => undefined);
                const idle = stat ? service.isIdle(stat.mtimeMs) : true;
                if (!opts.all && !idle) {
                    skipped++;
                    continue;
                }

                const classification = await adapter.classifySession(session.source_path);
                const parentId = classification.parentNativeId
                    ? (activeStore.findSession(session.tool, classification.parentNativeId)?.id ?? null)
                    : null;
                const outcome = await service.rollupSession(session, classification.kind, parentId, idle ? 'final' : 'live');
                // wrote-but-not-complete is not success: it's a partially-applied
                // rebuild that got interrupted, and reporting it as "done" is
                // exactly the false-success line that hid the concurrency bug.
                if (outcome.complete) {
                    if (outcome.wrote) {
                        completed++;
                    }
                } else {
                    aborted++;
                }
            }

            const entries = callLog.readEntriesSince(runStart);
            const inTok = entries.reduce((s, e) => s + (e.inputTokens ?? 0), 0);
            const outTok = entries.reduce((s, e) => s + (e.outputTokens ?? 0), 0);
            console.log(`\nRolled up ${completed} session(s); ${skipped} still active (use --all to include).`);
            if (aborted > 0) {
                console.log(
                    `${aborted} session(s) ABORTED mid-rebuild (see "watermark moved" / "failed at batch" above) - re-run to retry them.`,
                );
            }
            console.log(
                `API calls: ${entries.length} — tokens ${inTok} in / ${outTok} out — est. cost $${estimateCostUsd(inTok, outTok).toFixed(4)}`,
            );
            if (aborted > 0) {
                process.exitCode = 1;
            }
        });
}
