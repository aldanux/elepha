import { readFileSync } from 'node:fs';
import path from 'node:path';

function readPackageVersion(): string {
    const packageRoot = path.resolve(import.meta.dirname, '..', '..');
    const manifest = JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8')) as { version?: unknown };
    if (typeof manifest.version !== 'string') {
        throw new Error('elepha package.json has an invalid version');
    }
    return manifest.version;
}

export const PACKAGE_VERSION = readPackageVersion();
