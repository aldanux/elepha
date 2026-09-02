import type { Command } from 'commander';
import { daemonHealth, integrationHealth } from '../../install/health-checks.js';
import { openDb } from '../../storage/db.js';
import { MemoryStore } from '../../storage/memory-store.js';
import { parseSince } from '../../storage/stats.js';
import { SummarizerCallLog } from '../../summarizer/call-log.js';
import { synthesisProviderName } from '../../summarizer/provider-config.js';
import { errorMessage } from '../../util/error.js';
import { synthesisStatusReport } from '../status.js';

// Daemon liveness, derived from the same heartbeat file `status` reports.
// `daemonHealth` is shared so `rollup --rebuild` can refuse to race a live
// daemon without duplicating the pid/staleness logic.
export function registerStatus(program: Command): void {
    program
        .command('status')
        .description('One-line daemon health check: running/stuck/not-running, last ingest time, turns in the last 24h')
        .action(() => {
            const now = Date.now();
            const { state, healthy } = daemonHealth();

            const store = new MemoryStore(openDb());
            const lastIngestedAt = store.getLastIngestedAt();
            const lastIngestStr = lastIngestedAt
                ? `${lastIngestedAt} (${humanAge(now - new Date(lastIngestedAt).getTime())} ago)`
                : 'never';
            const turns24h = store.getStats(parseSince('24h')).totalMemories;
            const pendingConsent = store.consent.list('pending').length;

            // Provider health is part of the verdict only when synthesis is
            // configured. Capture-only is the normal default, so historical call
            // failures cannot make an intentionally unconfigured daemon degraded.
            const callLogEntries24h = new SummarizerCallLog().readEntriesSince(parseSince('24h'));
            const synthesis = synthesisStatusReport(synthesisProviderName(), callLogEntries24h);

            console.log(`${state} — last ingest: ${lastIngestStr} — ${turns24h} turns in last 24h`);
            if (pendingConsent > 0) {
                console.log(`consent: ${pendingConsent} root(s) pending approval`);
            }
            console.log(synthesis.line);
            try {
                const integration = integrationHealth();
                const { bin, status: install } = integration;
                console.log(`install binary: ${bin}`);
                console.log(`Claude hook: ${install.claudeHook}`);
                console.log(`Claude UserPromptSubmit hook: ${install.claudeUserPromptSubmitHook}`);
                console.log(`Codex hook: ${install.codexHook}`);
                console.log(`Codex UserPromptSubmit hook: ${install.codexUserPromptSubmitHook}`);
                console.log(`Claude MCP: ${install.claudeMcp}`);
                console.log(`Codex MCP: ${install.codexMcp}`);
                console.log(`install: ${install.ready ? 'ready' : 'action required'}`);
                process.exitCode = healthy && synthesis.healthy && install.ready ? 0 : 1;
            } catch (error) {
                console.log(`install binary: ${errorMessage(error)}`);
                console.log('install: action required');
                process.exitCode = 1;
            }
        });
}

function humanAge(ms: number): string {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) {
        return `${s}s`;
    }
    const m = Math.round(s / 60);
    if (m < 60) {
        return `${m}m`;
    }
    const h = Math.round(m / 60);
    if (h < 24) {
        return `${h}h`;
    }
    return `${Math.round(h / 24)}d`;
}
