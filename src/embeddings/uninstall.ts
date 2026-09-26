import { randomUUID } from 'node:crypto';
import { lstatSync, realpathSync, renameSync, rmSync, type Stats } from 'node:fs';
import path from 'node:path';
import { elephaPaths } from '../config/paths.js';
import { errorMessage } from '../util/error.js';

export interface MemoryPlusRemovalPlan {
    path: string;
    physicalPath: string;
    dev: number;
    ino: number;
}

export const memoryPlusRenamedReport = (target: string): string =>
    `Runtime was renamed to ${JSON.stringify(target)}; recover any remaining contents there.`;

export const memoryPlusRenameFailureReport = (target: string): string =>
    `Could not rename Memory-Plus runtime; nothing removed: ${JSON.stringify(target)}.`;

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
    // An ancestor can change after validation. Atomically move to an unpredictable
    // sibling name so a replacement cannot be pre-positioned at the deletion path,
    // then verify the moved object's identity. This mitigates substitution without
    // claiming to pin ancestors across the remaining pathname operations.
    const renamedPath = path.join(path.dirname(plan.physicalPath), `.memory-plus-removing-${randomUUID()}`);
    try {
        renameSync(plan.physicalPath, renamedPath);
    } catch (error) {
        throw new Error(`${memoryPlusRenameFailureReport(plan.physicalPath)} ${errorMessage(error)}`, { cause: error });
    }
    try {
        const stat = lstatSync(renamedPath);
        if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== plan.dev || stat.ino !== plan.ino) {
            //noinspection ExceptionCaughtLocallyJS
            throw new Error('Memory-Plus runtime identity changed after rename; nothing removed.');
        }
        // Recursive filesystem removal does not follow child symlinks. No npm,
        // lifecycle scripts, model cache, or elepha installation teardown is involved.
        rmSync(renamedPath, { recursive: true });
        if (statIfPresent(renamedPath) || statIfPresent(plan.physicalPath) || statIfPresent(plan.path)) {
            //noinspection ExceptionCaughtLocallyJS
            throw new Error(`Memory-Plus runtime still exists after removal: ${JSON.stringify(plan.path)}.`);
        }
    } catch (error) {
        throw new Error(`${errorMessage(error)} ${memoryPlusRenamedReport(renamedPath)}`, { cause: error });
    }
}
