import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';

//noinspection JSUnusedGlobalSymbols
export function setup(): void {
    // Some tests execute the released bin entrypoint from dist/. Build once
    // before workers start so no test can replace artifacts another is using.
    execFileSync(process.execPath, [path.resolve('node_modules/typescript/bin/tsc'), '-p', 'tsconfig.json'], {
        cwd: process.cwd(),
        stdio: 'pipe',
    });

    const testScratchRoot = path.join(process.cwd(), '.test-scratch');

    try {
        rmSync(testScratchRoot, { recursive: true, force: true });
    } catch {
        // Cleanup is a courtesy; sandbox permissions must not fail the test suite.
    }

    mkdirSync(testScratchRoot, { recursive: true });
}
