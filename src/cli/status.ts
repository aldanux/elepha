import type { LiveMemoryRetentionReport } from '../storage/live-memory-retention.js';
import type { SummarizerCallLogEntry } from '../summarizer/call-log.js';

export interface SynthesisStatusReport {
    line: string;
    healthy: boolean;
}

export function synthesisStatusReport(providerName: string | undefined, callLogEntries: SummarizerCallLogEntry[]): SynthesisStatusReport {
    if (!providerName) {
        return {
            line: 'synthesis: capture-only (no provider configured; turn extraction and rollup merge skipped)',
            healthy: true,
        };
    }

    if (callLogEntries.length === 0) {
        return { line: `synthesis: ${providerName} configured — no calls in last 24h`, healthy: true };
    }

    const okCalls = callLogEntries.filter((entry) => entry.status === 'ok').length;
    const healthy = okCalls / callLogEntries.length >= 0.5;
    const pct = ((100 * okCalls) / callLogEntries.length).toFixed(0);
    let line = `synthesis: ${providerName} configured — ${okCalls}/${callLogEntries.length} calls ok (${pct}%) in last 24h`;
    const lastFailure = [...callLogEntries].reverse().find((entry) => entry.status !== 'ok');
    if (lastFailure) {
        const reason = lastFailure.error ?? lastFailure.status;
        line += ` — last failure ${lastFailure.timestamp} (${reason})`;
    }
    return { line, healthy };
}

function decimalBytes(totalBytes: number): string {
    const units = ['bytes', 'kB', 'MB', 'GB', 'TB'] as const;
    let value = totalBytes;
    let unit = 0;
    while (value >= 1000 && unit < units.length - 1) {
        value /= 1000;
        unit += 1;
    }
    return unit === 0 ? `${totalBytes} bytes` : `${value.toFixed(2)} ${units[unit]}`;
}

// Removed sessions are reported by identity so deleted history is never
// mistaken for a session that simply had no turns, and every deferred capture
// is a named coverage gap rather than a silent skip.
export function liveMemoryRetentionLines(report: LiveMemoryRetentionReport): string[] {
    const lines: string[] = [];
    if (report.removedSessions > 0) {
        lines.push(
            `live-memory cleanup: removed ${report.removedSessions} whole session(s) (${decimalBytes(report.removedBytes)}) at capacity; their history is no longer in memory`,
        );
        for (const removal of report.recentRemovals) {
            lines.push(
                `  removed ${removal.tool}:${removal.native_id} (started ${removal.source_started_at ?? 'unknown'}) at ${removal.removed_at}`,
            );
        }
        if (report.recentRemovals.length < report.removedSessions) {
            lines.push(`  … and ${report.removedSessions - report.recentRemovals.length} earlier removal(s)`);
        }
    }
    if (report.state?.outcome === 'failed') {
        lines.push(
            `live-memory cleanup: last attempt at ${report.state.attempted_at} failed (${report.state.reason}); nothing was removed`,
        );
    } else if (report.state?.outcome === 'unconfirmed') {
        lines.push(
            `live-memory cleanup: ERROR — the cleanup at ${report.state.attempted_at} could not be confirmed (${report.state.reason}); recovery backup: ${report.state.backup_path}`,
        );
    }
    if (report.deferrals.length > 0) {
        lines.push(
            `live-memory capacity: capture deferred for ${report.deferrals.length} chat(s); their newest turns are not in memory yet`,
        );
        for (const deferral of report.deferrals) {
            lines.push(`  deferred ${deferral.tool}:${deferral.native_id} (${deferral.reason}) since ${deferral.last_deferred_at}`);
        }
    }
    return lines;
}

// Decimal units, matching how storage capacities are stated. The value is the
// logical live-memory ledger, not the size of the database file on disk.
export function liveMemoryUsageLine(totalBytes: number): string {
    const scaled = decimalBytes(totalBytes);
    const exact = totalBytes < 1000 ? '' : ` (${totalBytes.toLocaleString('en-US')} bytes)`;
    return `live-memory usage: ${scaled}${exact} — logical stored memory, not disk use`;
}
