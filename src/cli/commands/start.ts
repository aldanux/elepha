import { unlinkSync } from 'node:fs';
import type { Command } from 'commander';
import { elephaLaunchFailurePath } from '../../config/paths.js';
import { IngestionDaemon } from '../../daemon/index.js';
import { RollupService } from '../../daemon/rollup-service.js';
import { openDb } from '../../storage/db.js';
import { MemoryStore } from '../../storage/memory-store.js';
import { RollupStore } from '../../storage/rollup-store.js';
import { createConfiguredSynthesisProviders } from '../../summarizer/provider-config.js';

export function registerStart(program: Command): void {
    program
        .command('start', { hidden: true })
        .description('Run the ingestion daemon in the foreground, watching sessions from supported AI coding tools')
        .action(() => {
            const log = (msg: string) => console.log(msg);
            const logError = (msg: string) => console.error(msg);
            const db = openDb();
            const store = new MemoryStore(db);
            if (store.consent.list('approved').length === 0) {
                console.log('capture is awaiting consent; run `elepha init` to choose projects, nothing to do, exiting.');
                return;
            }
            const rollups = new RollupStore(db);
            const providers = createConfiguredSynthesisProviders();
            const rollupService = providers
                ? new RollupService({
                      store,
                      rollups,
                      provider: providers.rollupMerge,
                      log,
                      logError,
                  })
                : undefined;
            log(
                providers
                    ? `[elepha] synthesis provider: ${providers.name}`
                    : '[elepha] no synthesis provider configured; running capture-only',
            );
            const daemon = new IngestionDaemon({ store, summarizer: providers?.turnExtraction, rollupService, rollups, log, logError });
            daemon.start();
            // A successful watcher plus first heartbeat is the only event that
            // clears a prior launcher failure; probes and status must preserve it.
            try {
                unlinkSync(elephaLaunchFailurePath());
            } catch {
                // No diagnostic record is the normal case.
            }
            const shutdown = () => {
                void daemon.stop().then(() => process.exit(0));
            };
            process.on('SIGINT', shutdown);
            process.on('SIGTERM', shutdown);
        });
}
