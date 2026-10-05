import type { ToolName } from '../types/index.js';

// Claude Code and Codex retain the bounded filtered projection of every turn
// capture has already admitted, whatever the legacy `durable-capture` key says,
// and without Memory-Plus or a synthesis provider. OpenCode is parked and keeps
// that key as its opt-in: flipping the key's default instead would silently
// activate OpenCode's copy path. This decides only what an admitted write
// stores; the capture switches, consent, incognito, source validation and
// self-ingestion checks decide admission and must run before it is consulted.
const AUTOMATIC_FILTERED_CAPTURE_TOOLS: ReadonlySet<ToolName> = new Set<ToolName>(['claude-code', 'codex']);

export function retainsFilteredCopy(tool: ToolName, legacyDurableCapture: boolean): boolean {
    return AUTOMATIC_FILTERED_CAPTURE_TOOLS.has(tool) || legacyDurableCapture;
}
