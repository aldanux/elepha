import { existsSync } from 'node:fs';
import type { Command } from 'commander';
import { canonicalizeExisting, elephaPaths, isWithin } from '../../config/paths.js';
import { getSetting, setSetting } from '../../config/settings.js';
import { assertMemoryPlusRemovalPlan, planMemoryPlusRemoval, removeMemoryPlusRuntime } from '../../embeddings/uninstall.js';
import { writeBackup } from '../../storage/backup.js';
import { defaultDbPath, openManagedDatabase } from '../../storage/db.js';
import { errorMessage } from '../../util/error.js';
import { confirmYesNo } from '../shared.js';

export const MEMORY_PLUS_UNINSTALL_CONFIRM = 'Remove this local runtime and turn off Memory-Plus? [y/N] ';
export const MEMORY_PLUS_UNINSTALL_RETENTION = 'Stored vectors and downloaded models are retained. No memory rows will be deleted.';
export const memoryPlusRemovalReport = (target: string): string =>
    `Local runtime directory to remove (including all contents): ${JSON.stringify(target)}`;

export async function uninstallMemoryPlus(
    options: { confirm?: typeof confirmYesNo; log?: (message: string) => void } = {},
): Promise<boolean> {
    const log = options.log ?? console.log;
    const paths = elephaPaths();
    const configPath = paths.config;
    const dbPath = defaultDbPath();
    const plan = planMemoryPlusRemoval();
    if (!plan) {
        if (getSetting('memory-plus', {}, configPath).value) {
            setSetting('memory-plus', 'false', configPath);
        }
        log(`elepha's Memory-Plus runtime is already uninstalled. Memory-Plus is off. ${MEMORY_PLUS_UNINSTALL_RETENTION}`);
        return true;
    }
    const assertPlan = () => {
        assertMemoryPlusRemovalPlan(plan);
        // Configuration overrides and symlinks must not turn runtime removal
        // into deletion of memory, settings, or the retained model cache.
        for (const target of [dbPath, configPath, paths.embeddingModels]) {
            if (isWithin(plan.path, target) || isWithin(plan.physicalPath, canonicalizeExisting(target))) {
                throw new Error(`Memory-Plus runtime contains protected data; nothing removed: ${JSON.stringify(target)}.`);
            }
        }
    };
    assertPlan();
    log(memoryPlusRemovalReport(plan.physicalPath));
    if (plan.path !== plan.physicalPath) {
        log(`Configured runtime path: ${JSON.stringify(plan.path)}`);
    }
    log(MEMORY_PLUS_UNINSTALL_RETENTION);
    if (!(await (options.confirm ?? confirmYesNo)(MEMORY_PLUS_UNINSTALL_CONFIRM))) {
        log('Cancelled. Runtime and settings were not changed.');
        return false;
    }
    assertPlan();
    if (existsSync(dbPath)) {
        // Preserve the destructive-command backup rule without schema changes,
        // vector deletion, or pruning files outside the runtime being removed.
        const db = await openManagedDatabase(dbPath, { fileMustExist: true });
        try {
            assertPlan();
            log(`Backed up ${dbPath} to ${writeBackup(db, dbPath)}.`);
        } finally {
            db.close();
        }
    }
    assertPlan();
    // Disable before deleting: an active generator rechecks this setting before
    // inference and writes, and later daemon ticks never start a worker.
    setSetting('memory-plus', 'false', configPath);
    try {
        removeMemoryPlusRuntime(plan);
    } catch (error) {
        // Filesystem removal is not a SQLite transaction: a partial removal must
        // stay disabled and remain visible as a failure, safe to retry explicitly.
        throw new Error(`Memory-Plus is off; runtime removal failed: ${errorMessage(error)} ${MEMORY_PLUS_UNINSTALL_RETENTION}`, {
            cause: error,
        });
    }
    log(`elepha's Memory-Plus runtime removed. Memory-Plus is off. ${MEMORY_PLUS_UNINSTALL_RETENTION}`);
    return true;
}

export function registerUninstallMemoryPlus(uninstall: Command): void {
    uninstall
        .command('memory-plus')
        .description('Remove the isolated local runtime and turn off Memory-Plus; retain stored vectors')
        .action(async () => {
            try {
                await uninstallMemoryPlus();
            } catch (error) {
                console.error(`elepha's Memory-Plus uninstall failed: ${errorMessage(error)}`);
                process.exitCode = 1;
            }
        });
}
