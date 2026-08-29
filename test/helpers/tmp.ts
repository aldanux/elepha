import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { onTestFinished } from 'vitest';

const testScratchRoot = path.resolve(import.meta.dirname, '..', '..', '.test-scratch');

/** Creates an isolated test directory and removes it when the current test finishes. */
export function withTempDir(prefix: string): string {
    const directory = mkdtempSync(path.join(tmpdir(), prefix));
    onTestFinished(() => {
        rmSync(directory, { recursive: true, force: true });
    });
    return directory;
}

/** Creates a project fixture under the repository so production consent may grant it. */
export function withGrantableTestDir(prefix: string): string {
    mkdirSync(testScratchRoot, { recursive: true });
    const directory = mkdtempSync(path.join(testScratchRoot, prefix));
    // Stop Git discovery at the fixture boundary so independent test projects
    // do not collapse into the repository that contains .test-scratch.
    writeFileSync(path.join(directory, '.git'), `gitdir: ${path.join(directory, '.missing-git-dir')}\n`);
    onTestFinished(() => {
        try {
            rmSync(directory, { recursive: true, force: true });
        } catch {
            // Cleanup is a courtesy; sandbox permissions must not fail the assertion.
        }
    });
    return directory;
}
