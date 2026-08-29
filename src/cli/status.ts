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
