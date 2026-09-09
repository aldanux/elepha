import { unlinkSync } from 'node:fs';
import type { Command } from 'commander';
import { elephaLaunchFailurePath } from '../../config/paths.js';
import { IngestionDaemon } from '../../daemon/index.js';
import { RollupService } from '../../daemon/rollup-service.js';
import { DATABASE_MIGRATION_CONNECTIONS_ACTIVE, migratePrimaryDatabaseToEncrypted } from '../../storage/database-migration.js';
import { defaultDbPath, openDb } from '../../storage/db.js';
import { MemoryStore } from '../../storage/memory-store.js';
import { RollupStore } from '../../storage/rollup-store.js';
import { createConfiguredSynthesisProviders } from '../../summarizer/provider-config.js';
import { errorMessage } from '../../util/error.js';

export interface StartCommandRuntime {
    migrateDatabase(databasePath: string): Promise<unknown>;
}

const defaultStartCommandRuntime: StartCommandRuntime = {
    migrateDatabase: migratePrimaryDatabaseToEncrypted,
};

export function registerStart(program: Command, runtime: StartCommandRuntime = defaultStartCommandRuntime): void {
    program
        .command('start', { hidden: true })
        .description('Run the ingestion daemon in the foreground, watching sessions from supported AI coding tools')
        .action(async () => {
            const log = (msg: string) => console.log(msg);
            const logError = (msg: string) => console.error(msg);
            try {
                await runtime.migrateDatabase(defaultDbPath());
            } catch (error) {
                const message = errorMessage(error);
                if (message === DATABASE_MIGRATION_CONNECTIONS_ACTIVE || message.startsWith('database_lifecycle_busy:')) {
                    console.error(DATABASE_MIGRATION_CONNECTIONS_ACTIVE);
                    process.exitCode = 1;
                    return;
                }
                throw error;
            }
            const db = await openDb();
            const store = new MemoryStore(db);
            if (store.consent.list('approved').length === 0) {
                db.close();
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
                void daemon.stop().then(() => {
                    // Native process exit cannot release the managed lifecycle
                    // lease. Close after daemon shutdown so resume sees a clean owner.
                    db.close();
                    process.exit(0);
                });
            };
            process.on('SIGINT', shutdown);
            process.on('SIGTERM', shutdown);
        });
}
