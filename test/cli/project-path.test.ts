import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { isLiveProjectPath, isTempProjectPath } from '../../src/cli/project-path.js';

const repositoryRoot = path.resolve(import.meta.dirname, '..', '..');
const testScratchRoot = path.join(repositoryRoot, '.test-scratch');
const temporaryDirectories: string[] = [];

function removeDirectory(directory: string): void {
    try {
        rmSync(directory, { recursive: true, force: true });
    } catch {
        // Cleanup is a courtesy; sandbox permissions must not fail the assertion.
    }
}

afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
        removeDirectory(directory);
    }
});

describe('isLiveProjectPath', () => {
    it('accepts an existing non-temporary directory', () => {
        const directory = mkdtempSync(path.join(testScratchRoot, 'project-path-'));
        temporaryDirectories.push(directory);

        expect(isLiveProjectPath(directory)).toBe(true);
    });

    it('rejects a missing directory', () => {
        expect(isLiveProjectPath(path.join(process.cwd(), '.missing-project-path'))).toBe(false);
    });

    it('rejects a temporary directory', () => {
        expect(isLiveProjectPath(os.tmpdir())).toBe(false);
    });

    it('recognizes the physical macOS temporary tree', () => {
        expect(isTempProjectPath('/private/var/folders/zz/transient-checkout')).toBe(true);
    });
});
