import { statSync } from 'node:fs';
import type { OpenedProviderTranscript } from '../security/provider-transcript.js';
import { validateOpenedProviderTranscriptIdentitySync } from '../security/provider-transcript.js';
import type { ParsedTurn, ToolName } from '../types/index.js';
import { InjectionStore } from './injection-store.js';
import type { MemoryStore } from './memory-store.js';

import { sourceTurnDigest } from './source-turn-digest.js';

export function sourceSnapshotValidator(tool: ToolName, filePath: string, opened: OpenedProviderTranscript): () => boolean {
    return () => sourceSnapshotMismatch(tool, filePath, opened) === undefined;
}

export function sourceSnapshotMismatch(tool: ToolName, filePath: string, opened: OpenedProviderTranscript): string | undefined {
    const identity = validateOpenedProviderTranscriptIdentitySync(tool, filePath, opened);
    if ('reason' in identity) {
        return `physical identity or access changed (${identity.reason})`;
    }
    try {
        const current = statSync(filePath);
        if (current.dev !== opened.stat.dev || current.ino !== opened.stat.ino) {
            return 'physical identity changed';
        }
        if (current.size !== opened.stat.size) {
            return 'byte size changed';
        }
        if (current.mtimeMs !== opened.stat.mtimeMs) {
            return 'modification time changed';
        }
    } catch (error) {
        return `filesystem inspection failed (${(error as NodeJS.ErrnoException).code ?? 'unknown error'})`;
    }
    return undefined;
}

export function sourceGeneration(store: MemoryStore, tool: ToolName, nativeId: string): number {
    return (
        (
            store.database.prepare('SELECT generation FROM source_generations WHERE tool = ? AND native_id = ?').get(tool, nativeId) as
                | { generation: number }
                | undefined
        )?.generation ?? 0
    );
}

// Reusable for Pi's active-branch projection as well as files rewritten by undo/repair.
// Stream a comparison, retaining only an index and digest at a time. Retraction commits
// before new summaries are requested: interruption can leave less memory, never stale
// retracted memory. Subsequent normal ingest is idempotent and fills the missing suffix.
export class SourceReconciliation {
    private firstChanged = Number.POSITIVE_INFINITY;
    private lastIndex = -1;
    private readonly generation: number;
    private readonly lookup;
    private readonly injections: InjectionStore;
    private readonly mcpReceiptTurns: ParsedTurn[] = [];

    constructor(
        private readonly store: MemoryStore,
        private readonly tool: ToolName,
        private readonly nativeId: string,
        private readonly projectPath: string,
        private readonly validate: () => boolean,
    ) {
        this.generation = sourceGeneration(store, tool, nativeId);
        // A full-source replay must judge only receipts encountered in this
        // generation. Persisted receipts describe the previous source shape.
        this.injections = new InjectionStore(store.database, { includePersistedMcp: false });
        this.lookup = store.database.prepare(`SELECT m.source_digest FROM memories m JOIN sessions s ON s.id = m.session_id
            WHERE s.tool = ? AND s.native_id = ? AND m.turn_index = ? LIMIT 1`);
    }

    observe(turn: ParsedTurn): void {
        this.lastIndex = turn.turnIndex;
        turn.validateSource = this.validate;
        if (turn.droppedReason !== undefined) {
            if (turn.droppedReason === 'elepha-mcp') {
                if (!this.injections.rememberElephaMcpReceipts(turn)) {
                    throw new Error('Source reconciliation Elepha MCP receipt protection incomplete');
                }
                this.mcpReceiptTurns.push(turn);
            }
            return;
        }
        const quoteBackStatus = this.injections.quoteBackStatus(turn);
        if (quoteBackStatus === 'incomplete') {
            throw new Error('Source reconciliation quote-back protection incomplete');
        }
        if (quoteBackStatus === 'match') {
            return;
        }
        const stored = this.lookup.get(this.tool, this.nativeId, turn.turnIndex) as { source_digest: string | null } | undefined;
        if (stored && stored.source_digest !== sourceTurnDigest(turn)) {
            this.firstChanged = Math.min(this.firstChanged, turn.turnIndex);
        }
    }

    commit(): number {
        const fromIndex = Math.min(this.firstChanged, this.lastIndex + 1);
        return this.store.database.transaction(() => {
            if (
                !this.validate() ||
                this.store.consent.consentState(this.projectPath) !== 'approved' ||
                this.store.isTranscriptCaptureBlocked(this.tool, this.nativeId) ||
                this.store.isTranscriptIncognito(this.tool, this.nativeId) ||
                sourceGeneration(this.store, this.tool, this.nativeId) !== this.generation
            ) {
                throw new Error('Source reconciliation authorization or generation changed; retry required');
            }
            return this.applyRetraction(fromIndex);
        })();
    }

    private applyRetraction(fromIndex: number): number {
        const nextGeneration = this.generation + 1;
        const durableReceipts = new InjectionStore(this.store.database);
        for (const turn of this.mcpReceiptTurns) {
            if (!durableReceipts.recordElephaMcpReceipts(turn, nextGeneration)) {
                throw new Error('Source reconciliation Elepha MCP receipt protection incomplete');
            }
        }
        const db = this.store.database;
        db.prepare(`INSERT INTO source_generations (tool, native_id, generation) VALUES (?, ?, ?)
            ON CONFLICT(tool, native_id) DO UPDATE SET generation = excluded.generation`).run(this.tool, this.nativeId, nextGeneration);
        db.prepare('DELETE FROM open_turns WHERE tool = ? AND native_session_id = ?').run(this.tool, this.nativeId);
        const scope = 'SELECT id FROM sessions WHERE tool = ? AND native_id = ?';
        const count = (
            db
                .prepare(`SELECT COUNT(*) AS n FROM memories WHERE session_id IN (${scope}) AND turn_index >= ?`)
                .get(this.tool, this.nativeId, fromIndex) as { n: number }
        ).n;
        if (count === 0) {
            return 0;
        }
        // Cascades remove durable text and its FTS postings/usage in the same transaction.
        db.prepare(`DELETE FROM memories WHERE session_id IN (${scope}) AND turn_index >= ?`).run(this.tool, this.nativeId, fromIndex);
        db.prepare(`DELETE FROM session_rollups WHERE session_id IN (${scope})`).run(this.tool, this.nativeId);
        db.prepare(`DELETE FROM durable_capture_status WHERE session_id IN (${scope})`).run(this.tool, this.nativeId);
        db.prepare(`UPDATE sessions SET cursor = NULL, cursor_context = NULL, rendered_chars = NULL, rendered_turns = NULL,
            last_turn_at = NULL, trailing_branch = NULL, trailing_files = '[]',
            title = CASE WHEN EXISTS (SELECT 1 FROM memories WHERE session_id = sessions.id) THEN title ELSE NULL END,
            first_prompt_search = CASE WHEN EXISTS (SELECT 1 FROM memories WHERE session_id = sessions.id) THEN first_prompt_search ELSE NULL END
            WHERE tool = ? AND native_id = ?`).run(this.tool, this.nativeId);
        return count;
    }
}
