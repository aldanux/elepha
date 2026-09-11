// Table-driven mapping from each tool's raw surface/kind field to the
// normalized values sessions.surface/sessions.kind store. Values here are
// corpus-measured, not assumed. Update this table if future corpus evidence
// contradicts the values below.

import type { SessionKind, SessionRowKind, SessionRowSurface, ToolName } from '../types/index.js';

// Claude Code's `entrypoint` field. Confirmed values only.
export function claudeCodeSurface(entrypoint: string | undefined): SessionRowSurface | null {
    if (entrypoint === 'cli') {
        return 'cli';
    }
    if (entrypoint === 'claude-desktop') {
        return 'desktop';
    }
    return null;
}

// Codex's `originator` field. THREE distinct values, not two - "codex-tui" (59/66 sessions),
// "codex_exec" (6/66), "Codex Desktop" (1/66), full local corpus, no fourth
// value found. Both non-Desktop values are CLI-originated, so the predicate
// is "not Desktop", not "equals codex-tui". A value this table has never
// seen is treated as CLI too (same predicate), not as unknown - Desktop is
// the one value confirmed to mean something else.
export function codexSurface(originator: string | undefined): SessionRowSurface | null {
    if (originator === undefined) {
        return null;
    }
    return originator === 'Codex Desktop' ? 'desktop' : 'cli';
}

export function sessionSurface(tool: ToolName, raw: string | undefined): SessionRowSurface | null {
    if (tool === 'claude-code') {
        return claudeCodeSurface(raw);
    }
    if (tool === 'codex') {
        return codexSurface(raw);
    }
    if (tool === 'kimi') {
        return 'cli';
    }
    if (tool === 'deepseek') {
        return 'cli';
    }
    if (tool === 'opencode') {
        // Slice 1 has no reliable OpenCode surface discriminator and is not wired into ingestion.
        return null;
    }
    throw new Error(`Unsupported session surface provider: ${String(tool)}`);
}

const SESSION_KIND_MAP: Record<SessionKind, SessionRowKind> = {
    primary: 'main',
    subagent: 'subagent',
    'fork-copy': 'fork',
    adjudicator: 'adjudicator',
};

export function toSessionRowKind(kind: SessionKind): SessionRowKind {
    return SESSION_KIND_MAP[kind];
}
