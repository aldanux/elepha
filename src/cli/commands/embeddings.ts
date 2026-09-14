import type { Command } from 'commander';
import { getSetting } from '../../config/settings.js';
import { generateEmbeddings } from '../../embeddings/generate.js';
import { embeddingConfiguration } from '../../embeddings/provider-config.js';
import { openDb } from '../../storage/db.js';
import { MEMORY_PLUS_DISABLED } from '../../storage/embedding-store.js';
import { errorMessage } from '../../util/error.js';
import { confirmYesNo } from '../shared.js';
import { MEMORY_PLUS_API_NOTICE, MEMORY_PLUS_CONFIRM } from './enable.js';

export function registerEmbeddings(program: Command): void {
    program
        .command('embeddings')
        .description('Manually generate missing or stale semantic vectors from permitted stored session metadata')
        .option('--rebuild', 'regenerate every eligible vector; source sessions and rollups are preserved')
        .action(async (options: { rebuild?: boolean }) => {
            try {
                if (!getSetting('memory-plus').value) {
                    throw new Error(MEMORY_PLUS_DISABLED);
                }
                const environment = { ...process.env };
                if (embeddingConfiguration(true, environment)?.provider === 'openai') {
                    console.log(MEMORY_PLUS_API_NOTICE);
                    if (!(await confirmYesNo(MEMORY_PLUS_CONFIRM))) {
                        console.log('Cancelled. No vectors were generated.');
                        return;
                    }
                }
                const db = await openDb();
                try {
                    const result = await generateEmbeddings(db, { environment, rebuild: options.rebuild });
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
