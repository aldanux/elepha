import type { Command } from 'commander';
import { getSetting } from '../../config/settings.js';
import { generateEmbeddings } from '../../embeddings/generate.js';
import { openDb } from '../../storage/db.js';
import { MEMORY_PLUS_DISABLED } from '../../storage/embedding-store.js';
import { errorMessage } from '../../util/error.js';

export function registerEmbeddings(program: Command): void {
    program
        .command('embeddings')
        .description('Manually generate missing or stale semantic vectors from permitted stored session metadata')
        .option('--rebuild', 'regenerate every eligible vector; source sessions and rollups are preserved')
        .action(async (options: { rebuild?: boolean }) => {
            try {
                if (!getSetting('memory-plus').value) {
                    //noinspection ExceptionCaughtLocallyJS
                    throw new Error(MEMORY_PLUS_DISABLED);
                }
                const db = await openDb();
                try {
                    const result = await generateEmbeddings(db, { rebuild: options.rebuild });
                    console.log(
                        `Vectors: ${result.generated} generated, ${result.current} already current, ${result.ineligibleOrEmpty} ineligible or empty sessions skipped, ${result.sourceChanged} changed (retry next pass), ${result.failed} malformed (no inference).`,
                    );
                } finally {
                    db.close();
                }
            } catch (error) {
                console.error(`Embedding generation failed: ${errorMessage(error)} Completed vectors are retained; rerun to resume.`);
                process.exitCode = 1;
            }
        });
}
