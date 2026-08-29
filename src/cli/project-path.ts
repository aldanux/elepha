import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TEMPORARY_PROJECT_ROOTS } from '../config/constants.js';
import { canonicalizeExisting } from '../config/paths.js';

export function isPathWithin(parent: string, candidate: string): boolean {
    const relative = path.relative(path.resolve(parent), path.resolve(candidate));
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export function isTempProjectPath(projectPath: string): boolean {
    return [canonicalizeExisting(os.tmpdir()), ...TEMPORARY_PROJECT_ROOTS].some((tempPath) => isPathWithin(tempPath, projectPath));
}

export function isLiveProjectPath(projectPath: string): boolean {
    return existsSync(projectPath) && !isTempProjectPath(projectPath);
}
