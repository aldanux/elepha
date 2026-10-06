// User-facing live-memory capacity warning. It states installation-wide usage
// only, never a project or session detail, because any top-level checkout of
// any supported host may show it.

import type { Database } from 'better-sqlite3-multiple-ciphers';
import { LIVE_MEMORY_CAPACITY_BYTES } from '../config/live-memory-retention.js';
import { terminalHandoff } from '../markers.js';
import { type LiveMemoryWarningBand, type LiveMemoryWarningPolicy, liveMemoryWarningBand } from '../storage/live-memory-warning.js';

function gigabytes(bytes: number): string {
    return `${(bytes / 1_000_000_000).toFixed(2)} GB`;
}

export function liveMemoryWarningMessage(usageBytes: number, band: LiveMemoryWarningBand): string {
    const capacity = gigabytes(LIVE_MEMORY_CAPACITY_BYTES);
    const headline =
        band === 'urgent'
            ? `⚠ elepha: live memory is at ${gigabytes(usageBytes)} of its fixed ${capacity} capacity; automatic cleanup is close.`
            : `⚠ elepha: live memory is at ${gigabytes(usageBytes)} of its fixed ${capacity} capacity.`;
    return [
        headline,
        `When it reaches ${capacity}, elepha removes the oldest eligible complete sessions to make room.`,
        `Inspect usage: ${terminalHandoff('status')}`,
        `Preview a manual cleanup (dry run): ${terminalHandoff('purge --older-than 90d')}`,
    ].join('\n');
}

// `elepha status` shows the applicable warning on every invocation in either
// band. It only reads usage: it never consults or advances the chat-opening
// schedule, so running status neither consumes nor delays a chat warning.
export function liveMemoryWarningStatusLine(db: Database, policy: LiveMemoryWarningPolicy): string | undefined {
    if (!policy.enabled) {
        return undefined;
    }
    const usageBytes = policy.readUsage(db);
    const band = liveMemoryWarningBand(usageBytes);
    return band === undefined ? undefined : liveMemoryWarningMessage(usageBytes, band);
}
