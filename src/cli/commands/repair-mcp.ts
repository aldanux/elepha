import type { Command } from 'commander';
import { defaultAdapters } from '../../adapters/index.js';
import { openDb } from '../../storage/db.js';
import { applyMcpRepair, type McpRepairPlan, planMcpRepair, verifyMcpRepair } from '../../storage/mcp-repair.js';
import { MemoryStore } from '../../storage/memory-store.js';
import { LOCKED_MEMORY_MESSAGE, withMemoryReadGeneration } from '../../storage/paranoid-gate.js';
import { isToolName } from '../../types/index.js';
import { runDestructiveOp } from '../destructive-op.js';

export function registerRepairMcp(program: Command): void {
    program
        .command('repair-mcp-self-ingestion', { hidden: true })
        .description(
            'Remove stale memories from source-verified Elepha MCP turns and rebuild their receipts. No model calls; dry-run by default.',
        )
        .requiredOption('--tool <tool>', 'provider: codex or claude-code')
        .requiredOption('--session <native-id>', 'exact native session id')
        .option('--apply', 'apply the previewed repair after a database backup')
        .action(async (opts: { tool: string; session: string; apply: boolean }) => {
            if (!isToolName(opts.tool) || opts.tool === 'opencode') {
                throw new Error('Use --tool codex or --tool claude-code');
            }
            const tool = opts.tool;
            const db = await openDb();
            const store = new MemoryStore(db);
            let plan: McpRepairPlan | undefined;
            try {
                await runDestructiveOp({
                    db,
                    applyRequested: opts.apply,
                    operationLabel: 'repair MCP memories',
                    plan: async () => {
                        plan = await planMcpRepair(store, defaultAdapters(), tool, opts.session);
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
                                    console.log(`Delete memory ${memory.id}: session ${memory.session_id}, turn ${memory.turn_index}`);
                                }
                                console.log(
                                    `Invalidate rollups, embeddings and durable status; rebuild metadata for sessions: ${[...new Set(preview.memories.map((m) => m.session_id))].join(', ') || 'none'}`,
                                );
                                for (const receipt of preview.missingReceipts) {
                                    console.log(`Insert MCP receipt: turn ${receipt.turnIndex}, call ${JSON.stringify(receipt.callId)}`);
                                }
                            },
                            preview.readGeneration,
                        ),
                    isEmpty: (preview) => preview.memories.length === 0 && preview.missingReceipts.length === 0,
                    onEmpty: () => {
                        console.log('Nothing to repair.');
                    },
                    messages: { dryRun: 'Dry run only - nothing was written. Re-run with --apply to repair these exact rows.' },
                    apply: (preview) => applyMcpRepair(store, preview),
                    verify: (preview) => {
                        verifyMcpRepair(store, preview);
                        console.log(`Verified: removed ${preview.memories.length} stale MCP memory row(s); receipts persisted.`);
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
