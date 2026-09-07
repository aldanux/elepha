import { readFileSync } from 'node:fs';
import path from 'node:path';

const packageJsonPath = path.join(path.resolve(import.meta.dirname, '..', '..'), 'package.json');

export function readInstalledPackageVersion(): string | undefined {
    try {
        const manifest = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { version?: unknown };
        return typeof manifest.version === 'string' ? manifest.version : undefined;
    } catch {
        return undefined;
    }
}

function readPackageVersion(): string {
    const version = readInstalledPackageVersion();
    if (version === undefined) {
        throw new Error('elepha package.json has an invalid version');
    }
    return version;
}

export const PACKAGE_VERSION = readPackageVersion();
