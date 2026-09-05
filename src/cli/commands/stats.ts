import type { Command } from 'commander';
import { openDb } from '../../storage/db.js';
import { MemoryStore } from '../../storage/memory-store.js';
import { parseSince, type Stats } from '../../storage/stats.js';
import { withCliReadGeneration } from '../read-gate.js';

export function registerStats(program: Command): void {
    program
        .command('stats', { hidden: true })
        .description(
            'Dogfooding instrumentation: ingestion volume, summarizer noise rate, pending_items accumulation, files_touched miss rate',
        )
        .option('--since <window>', 'time window: "24h", "7d", "30m", or an ISO date', '24h')
        .action(async (opts: { since: string }) => {
            const db = await openDb();
            await withCliReadGeneration(db, (output) => {
                const store = new MemoryStore(db);
                const sinceIso = parseSince(opts.since);
                printStats(store.getStats(sinceIso), output.log);
            });
        });
}

function printStats(s: Stats, output: (message: string) => void = console.log): void {
    output(`stats since ${s.since}  (${s.totalMemories} memories total)\n`);

    output('sessions/turns by tool:');
    for (const t of s.byTool) {
        output(`  ${t.tool}: ${t.sessions} sessions, ${t.turns} turns`);
    }

    const mps = s.memoriesPerSession;
    output(`\nmemories per session: min ${mps.min} / median ${mps.median} / max ${mps.max}  (n=${mps.count} sessions)`);

    const pps = s.pendingItemsPerSession;
    output(`pending_items per session: min ${pps.min} / median ${pps.median} / max ${pps.max}`);

    const noisePct = s.noise.total > 0 ? ((100 * s.noise.count) / s.noise.total).toFixed(1) : '0.0';
    output(`\nnoise (empty decisions AND empty pending_items): ${s.noise.count}/${s.noise.total} (${noisePct}%)`);

    output('\nby summarizer_status (breaks noise into genuine-silence vs pipeline-failure):');
    for (const s2 of s.byStatus) {
        const pct = s.noise.total > 0 ? ((100 * s2.count) / s.noise.total).toFixed(1) : '0.0';
        output(`  ${s2.summarizer_status}: ${s2.count} (${pct}%)`);
    }

    output('\nfiles_touched = zero paths, by tool:');
    for (const f of s.filesTouchedZero) {
        const pct = f.total > 0 ? ((100 * f.zero_paths) / f.total).toFixed(1) : '0.0';
        output(`  ${f.tool}: ${f.zero_paths}/${f.total} (${pct}%)`);
    }

    output('\nby project (memories / open pending_items):');
    for (const p of s.byProject) {
        output(`  ${p.project}: ${p.memories} / ${p.open_pending_items ?? 0}`);
    }
}
