import type { Command } from 'commander';
import { defaultAdapters } from '../../adapters/index.js';
import {
    applyCompactSummaryRepair,
    type CompactSummaryRepairPlan,
    planCompactSummaryRepair,
    verifyCompactSummaryRepair,
} from '../../storage/claude-compact-repair.js';
import { openDb } from '../../storage/db.js';
import { MemoryStore } from '../../storage/memory-store.js';
import { LOCKED_MEMORY_MESSAGE, withMemoryReadGeneration } from '../../storage/paranoid-gate.js';
import { runDestructiveOp } from '../destructive-op.js';

export function registerRepairClaudeCompact(program: Command): void {
    program
        .command('repair-claude-compact-summaries', { hidden: true })
        .description(
            'Remove stale memories stored from source-verified Claude Code compact summaries that have no continuation. No model calls; dry-run by default.',
        )
        .requiredOption('--session <native-id>', 'exact Claude Code native session id')
        .option('--apply', 'apply the previewed repair after a database backup')
        .action(async (opts: { session: string; apply: boolean }) => {
            const db = await openDb();
            const store = new MemoryStore(db);
            let plan: CompactSummaryRepairPlan | undefined;
            try {
                await runDestructiveOp({
                    db,
                    applyRequested: opts.apply,
                    operationLabel: 'repair compact summary memories',
                    plan: async () => {
                        plan = await planCompactSummaryRepair(store, defaultAdapters(), opts.session);
                        return plan;
                    },
                    describe: (preview) =>
                        withMemoryReadGeneration(
                            db,
                            () => {
                                throw new Error(LOCKED_MEMORY_MESSAGE);
                            },
                            () => {
                                console.log(`Source: ${preview.sourcePath}`);
                                console.log(`Session: ${preview.tool}/${preview.nativeId}`);
                                for (const memory of preview.memories) {
                                    console.log(
                                        `Delete summary-only memory ${memory.id}: session ${memory.session_id}, turn ${memory.turn_index}`,
                                    );
                                }
                                console.log(
                                    `Invalidate rollups, embeddings and durable status; rebuild metadata for sessions: ${[...new Set(preview.memories.map((m) => m.session_id))].join(', ') || 'none'}`,
                                );
                                for (const memory of preview.unresolved) {
                                    console.log(
                                        `Unresolved compact continuation memory ${memory.id}: session ${memory.session_id}, turn ${memory.turn_index} (kept unchanged)`,
                                    );
                                }
                                if (preview.unresolved.length > 0) {
                                    console.log(
                                        'Continuation rows may still carry compact summary text from earlier parses. --apply removes only summary-only rows, not all historical contamination.',
                                    );
                                }
                            },
                            preview.readGeneration,
                        ),
                    isEmpty: (preview) => preview.memories.length === 0,
                    onEmpty: () => {
                        console.log('No summary-only compact memories to repair.');
                    },
                    messages: {
                        dryRun: 'Dry run only - nothing was written. Re-run with --apply to delete these exact summary-only rows.',
                    },
                    apply: (preview) => applyCompactSummaryRepair(store, preview),
                    verify: (preview) => {
                        verifyCompactSummaryRepair(store, preview);
                        console.log(`Verified: removed ${preview.memories.length} summary-only compact memory row(s).`);
                    },
                });
            } finally {
                await plan?.close();
                if (db.open) {
                    db.close();
                }
            }
        });
}
