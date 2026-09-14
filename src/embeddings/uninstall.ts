import { lstatSync, realpathSync, rmSync, type Stats } from 'node:fs';
import path from 'node:path';
import { elephaPaths } from '../config/paths.js';

export interface MemoryPlusRemovalPlan {
    path: string;
    physicalPath: string;
    dev: number;
    ino: number;
}

function statIfPresent(target: string): Stats | undefined {
    try {
        return lstatSync(target);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return;
        }
        throw error;
    }
}

export function planMemoryPlusRemoval(): MemoryPlusRemovalPlan | undefined {
    const paths = elephaPaths();
    const stat = statIfPresent(paths.memoryPlus);
    if (!stat) {
        return;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error(`Refusing to remove a non-directory or symlink: ${JSON.stringify(paths.memoryPlus)}.`);
    }
    const physicalPath = realpathSync(paths.memoryPlus);
    if (physicalPath !== path.join(realpathSync(paths.root), 'memory-plus')) {
        throw new Error(`Memory-Plus runtime resolves outside its managed directory: ${JSON.stringify(paths.memoryPlus)}.`);
    }
    return { path: paths.memoryPlus, physicalPath, dev: stat.dev, ino: stat.ino };
}

export function assertMemoryPlusRemovalPlan(plan: MemoryPlusRemovalPlan): void {
    const stat = statIfPresent(plan.path);
    // Never expand or rebuild the confirmed plan after an awaited prompt or DB
    // open. A replacement directory, symlink or changed home requires a new run.
    if (
        elephaPaths().memoryPlus !== plan.path ||
        !stat?.isDirectory() ||
        stat.isSymbolicLink() ||
        stat.dev !== plan.dev ||
        stat.ino !== plan.ino ||
        realpathSync(plan.path) !== plan.physicalPath
    ) {
        throw new Error(`Memory-Plus runtime changed since preview; nothing removed: ${JSON.stringify(plan.path)}.`);
    }
}

export function removeMemoryPlusRuntime(plan: MemoryPlusRemovalPlan): void {
    assertMemoryPlusRemovalPlan(plan);
    // Recursive filesystem removal does not follow child symlinks. No npm,
    // lifecycle scripts, model cache, or elepha installation teardown is involved.
    rmSync(plan.physicalPath, { recursive: true });
    if (statIfPresent(plan.physicalPath) || statIfPresent(plan.path)) {
        throw new Error(`Memory-Plus runtime still exists after removal: ${JSON.stringify(plan.path)}.`);
    }
}
