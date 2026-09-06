import type { Command } from 'commander';
import { openDb } from '../../storage/db.js';
import { type MemoryRow, MemoryStore } from '../../storage/memory-store.js';
import { type GuardedCliOutput, withCliReadGeneration } from '../read-gate.js';

export function registerInspect(program: Command): void {
    program
        .command('inspect')
        .description('Print recently captured memory for a project - for sanity-checking the ingestion pipeline')
        .argument('<project>', 'project path, path suffix, or display name')
        .option('-n, --limit <n>', 'number of recent turns to show', '10')
        .action(async (query: string, opts: { limit: string }) => {
            const db = await openDb();
            await withCliReadGeneration(db, (output) => {
                const store = new MemoryStore(db);
                const project = store.findProject(query);
                if (!project) {
                    output.error(`No project matching "${query}". Known projects:`);
                    for (const p of store.listProjects()) {
                        output.error(`  ${p.path}`);
                    }
                    process.exitCode = 1;
                    return;
                }

                const limit = Number(opts.limit) || 10;
                const memories = store.listRecentMemories(project.id, limit);
                output.log(`${project.display_name ?? project.path}  (${project.path})`);
                if (project.git_remote) {
                    output.log(`git: ${project.git_remote}`);
                }
                output.log(`${memories.length} recent turn(s):\n`);

                for (const m of memories) {
                    printMemory(m, output);
                }
            });
        });
}

function printMemory(m: MemoryRow, output: Pick<GuardedCliOutput, 'log'>): void {
    output.log(`--- ${m.turn_started_at} (${m.tool}) turn #${m.turn_index}`);
    if (m.decisions.length > 0) {
        output.log('  decisions:');
        for (const d of m.decisions) {
            output.log(`    - ${d}`);
        }
    }
    if (m.files_touched.length > 0) {
        output.log('  files_touched:');
        for (const f of m.files_touched) {
            output.log(`    - ${f}`);
        }
    }
    if (m.pending_items.length > 0) {
        output.log('  pending_items:');
        for (const p of m.pending_items) {
            output.log(`    - ${p}`);
        }
    }
    output.log('');
}
