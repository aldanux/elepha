import type { Command } from 'commander';
import { openDb } from '../../storage/db.js';
import { type MemoryRow, MemoryStore } from '../../storage/memory-store.js';

export function registerInspect(program: Command): void {
    program
        .command('inspect')
        .description('Print recently captured memory for a project - for sanity-checking the ingestion pipeline')
        .argument('<project>', 'project path, path suffix, or display name')
        .option('-n, --limit <n>', 'number of recent turns to show', '10')
        .action((query: string, opts: { limit: string }) => {
            const store = new MemoryStore(openDb());
            const project = store.findProject(query);
            if (!project) {
                console.error(`No project matching "${query}". Known projects:`);
                for (const p of store.listProjects()) {
                    console.error(`  ${p.path}`);
                }
                process.exitCode = 1;
                return;
            }

            const limit = Number(opts.limit) || 10;
            const memories = store.listRecentMemories(project.id, limit);
            console.log(`${project.display_name ?? project.path}  (${project.path})`);
            if (project.git_remote) {
                console.log(`git: ${project.git_remote}`);
            }
            console.log(`${memories.length} recent turn(s):\n`);

            for (const m of memories) {
                printMemory(m);
            }
        });
}

function printMemory(m: MemoryRow): void {
    console.log(`--- ${m.turn_started_at} (${m.tool}) turn #${m.turn_index}`);
    if (m.decisions.length > 0) {
        console.log('  decisions:');
        for (const d of m.decisions) {
            console.log(`    - ${d}`);
        }
    }
    if (m.files_touched.length > 0) {
        console.log('  files_touched:');
        for (const f of m.files_touched) {
            console.log(`    - ${f}`);
        }
    }
    if (m.pending_items.length > 0) {
        console.log('  pending_items:');
        for (const p of m.pending_items) {
            console.log(`    - ${p}`);
        }
    }
    console.log('');
}
