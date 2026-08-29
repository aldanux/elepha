import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';

//noinspection JSUnusedGlobalSymbols
export function setup(): void {
    const testScratchRoot = path.join(process.cwd(), '.test-scratch');

    try {
        rmSync(testScratchRoot, { recursive: true, force: true });
    } catch {
        // Cleanup is a courtesy; sandbox permissions must not fail the test suite.
    }

    mkdirSync(testScratchRoot, { recursive: true });
}
