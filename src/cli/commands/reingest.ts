import type { Command } from 'commander';
import { ClaudeCodeAdapter } from '../../adapters/claude-code.js';
import { CodexAdapter } from '../../adapters/codex.js';
import { isWithinProviderStore } from '../../config/paths.js';
import { openDb } from '../../storage/db.js';
import { MemoryStore } from '../../storage/memory-store.js';
import { parseSince } from '../../storage/stats.js';
import { SummarizerCallLog } from '../../summarizer/call-log.js';
import { estimateCostUsd } from '../../summarizer/pricing.js';
import { createConfiguredSynthesisProviders } from '../../summarizer/provider-config.js';
import type { SessionAdapter, ToolName } from '../../types/index.js';

export function registerReingest(program: Command): void {
    program
        .command('reingest', { hidden: true })
        .description(
            'Reprocess already-ingested turns in a time window through the current summarizer/adapters - use after fixing a summarizer or adapter bug. Overwrites existing rows; never touches the live daemon cursor, safe to run alongside `elepha start`.',
        )
        .option('--since <window>', 'time window: "24h", "7d", "30d", or an ISO date', '7d')
        .option('--limit <n>', 'stop after N turns - bounds the spend when measuring a prompt change before committing to a full pass', '0')
        .action(async (opts: { since: string; limit: string }) => {
            const providers = createConfiguredSynthesisProviders();
            if (!providers) {
                console.error('No synthesis provider configured. Set ANTHROPIC_API_KEY before running reingest.');
                process.exitCode = 1;
                return;
            }
            const limit = Number(opts.limit) || 0;
            const store = new MemoryStore(openDb());
            const cutoffIso = parseSince(opts.since);
            const sessions = store.listSessionsWithMemoriesSince(cutoffIso);
            if (sessions.length === 0) {
                console.log(`No sessions with memories since ${cutoffIso}. Nothing to reingest.`);
                return;
            }

            const adapters: Record<ToolName, SessionAdapter> = {
                'claude-code': new ClaudeCodeAdapter(),
                codex: new CodexAdapter(),
            };
            const callLog = new SummarizerCallLog();
            const summarizer = providers.turnExtraction;

            const runStart = new Date().toISOString();
            let turnsReprocessed = 0;
            let sessionsTouched = 0;

            for (const session of sessions) {
                if (limit > 0 && turnsReprocessed >= limit) {
                    break;
                }
                if (!isWithinProviderStore(session.tool, session.source_path)) {
                    console.log(`skipped ${session.native_id}: source_path outside provider store`);
                    continue;
                }
                const adapter = adapters[session.tool];
                let sessionHadReingest = false;
                // Re-walks the whole file from byte 0 - cheap/local, no API cost.
                // Turns before the cutoff are re-derived but skipped, never
                // re-summarized or re-written; only in-window turns cost a call.
                for await (const turn of adapter.parseTurns(session.source_path, undefined, { closeTrailingOnIdle: true })) {
                    if (turn.startedAt < cutoffIso) {
                        continue;
                    }
                    if (limit > 0 && turnsReprocessed >= limit) {
                        break;
                    }
                    const summary = await summarizer.summarize({ userMessage: turn.userMessage, assistantText: turn.assistantText });
                    store.reingestTurn(turn, session.id, session.project_id, summary);
                    turnsReprocessed++;
                    sessionHadReingest = true;
                }
                if (sessionHadReingest) {
                    sessionsTouched++;
                }
            }

            const durationMs = Date.now() - new Date(runStart).getTime();
            const entries = callLog.readEntriesSince(runStart);
            const inputTokens = entries.reduce((sum, e) => sum + (e.inputTokens ?? 0), 0);
            const outputTokens = entries.reduce((sum, e) => sum + (e.outputTokens ?? 0), 0);
            const okCalls = entries.filter((e) => e.status === 'ok').length;

            console.log(
                `Reingested ${turnsReprocessed} turn(s) across ${sessionsTouched}/${sessions.length} session(s) since ${cutoffIso}.`,
            );
            console.log(`API calls: ${entries.length} (${okCalls} ok, ${entries.length - okCalls} failed/repaired)`);
            console.log(
                `Tokens: ${inputTokens} in / ${outputTokens} out — est. cost $${estimateCostUsd(inputTokens, outputTokens).toFixed(4)}`,
            );
            console.log(`Duration: ${(durationMs / 1000).toFixed(1)}s`);
        });
}
