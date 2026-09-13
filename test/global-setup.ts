import { execFileSync } from 'node:child_process';
import { chmodSync, lstatSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';

function makeWritable(entry: string): void {
    const stat = lstatSync(entry);
    // Fixtures may link outside the scratch tree; only remove the link itself.
    if (stat.isSymbolicLink()) return;

    chmodSync(entry, stat.isDirectory() ? 0o700 : 0o600);
    if (stat.isDirectory()) {
        for (const child of readdirSync(entry)) {
            makeWritable(path.join(entry, child));
        }
    }
}

export function sweepTestScratch(root: string): { removed: string[]; remaining: string[] } {
    const removed: string[] = [];
    const remaining: string[] = [];
    let entries: string[] = [];
    let scanError: unknown;
    try {
        entries = readdirSync(root);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') scanError = error;
    }

    for (const entry of entries) {
        const target = path.join(root, entry);
        try {
            try {
                makeWritable(target);
            } catch {
                // Removal may still succeed when chmod is denied but the parent is writable.
            }
            rmSync(target, { recursive: true, force: true });
            removed.push(entry);
        } catch {
            // One stubborn fixture must not prevent cleanup of the other entries.
            remaining.push(entry);
        }
    }

    const leftovers = remaining.length > 0 ? `: ${remaining.map((entry) => JSON.stringify(entry)).join(', ')}` : '';
    const scanFailure = scanError ? `; could not list ${JSON.stringify(root)}: ${JSON.stringify(String(scanError))}` : '';
    console.log(`[test-scratch] removed ${removed.length}; remaining ${remaining.length}${leftovers}${scanFailure}`);
    mkdirSync(root, { recursive: true });
    return { removed, remaining };
}

//noinspection JSUnusedGlobalSymbols
export function setup(): void {
    // Some tests execute the released bin entrypoint from dist/. Build once
    // before workers start so no test can replace artifacts another is using.
    execFileSync(process.execPath, [path.resolve('node_modules/typescript/bin/tsc'), '-p', 'tsconfig.json'], {
        cwd: process.cwd(),
        stdio: 'pipe',
    });

    const testScratchRoot = path.join(process.cwd(), '.test-scratch');

    sweepTestScratch(testScratchRoot);
}
