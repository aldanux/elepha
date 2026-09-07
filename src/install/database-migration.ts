import { DATABASE_MIGRATION_CONNECTIONS_ACTIVE, migratePrimaryDatabaseToEncrypted } from '../storage/database-migration.js';
import { errorMessage } from '../util/error.js';
import { type ResolvedElephaBin, resolveInstalledElephaBin } from './binary.js';
import { retireLegacyMcpReaders } from './legacy-mcp.js';

export interface InstallDatabaseMigrationRuntime {
    migrate?: (databasePath: string) => Promise<unknown>;
    resolveInstalledBin?: () => ResolvedElephaBin;
    retireReaders?: typeof retireLegacyMcpReaders;
    report?: (message: string) => void;
}

export function retiredLegacyMcpMessage(count: number): string {
    return `Retired ${count} stale elepha MCP process(es); retrying database migration.`;
}

// The storage migration keeps full ownership of locking, backups, and recovery.
// Only installation may retire a proven obsolete client and retry it once.
export async function migrateDatabaseForInstall(databasePath: string, runtime: InstallDatabaseMigrationRuntime = {}): Promise<void> {
    const migrate = runtime.migrate ?? migratePrimaryDatabaseToEncrypted;
    try {
        await migrate(databasePath);
        return;
    } catch (error) {
        if (errorMessage(error) !== DATABASE_MIGRATION_CONNECTIONS_ACTIVE) {
            throw error;
        }
        const installed = (runtime.resolveInstalledBin ?? resolveInstalledElephaBin)();
        const count = await (runtime.retireReaders ?? retireLegacyMcpReaders)(databasePath, installed);
        if (count === 0) {
            throw error;
        }
        (runtime.report ?? console.error)(retiredLegacyMcpMessage(count));
    }
    await migrate(databasePath);
}
