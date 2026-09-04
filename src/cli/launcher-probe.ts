import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { errorMessage } from '../util/error.js';

export interface LauncherProbeFailure {
    check: string;
    expected: string;
    observed: string;
    packageName: unknown;
    enginesNode: unknown;
    nodeVersion: string;
    execPath: string;
    declaredBin: unknown;
    packageRoot: string;
    minimum: string;
}

export type LauncherProbeResult = { passes: true } | { passes: false; failure: LauncherProbeFailure };

function value(value: unknown): string {
    return JSON.stringify(value) ?? String(value);
}

function failed(
    check: string,
    expected: string,
    observed: string,
    details: Omit<LauncherProbeFailure, 'check' | 'expected' | 'observed'>,
): LauncherProbeResult {
    return { passes: false, failure: { check, expected, observed, ...details } };
}

export function formatLauncherProbeFailure(failure: LauncherProbeFailure): string {
    const validMinimum = /^\d+\.\d+\.\d+$/.test(failure.minimum);
    const expectedEngine = validMinimum ? `>=${failure.minimum}` : 'canonical >=N.N.N';
    const expectedNodeVersion = validMinimum ? `>=${failure.minimum}` : 'semantic version';
    return [
        `launcher probe failed: ${failure.check}`,
        `expected: ${failure.expected}`,
        `observed: ${failure.observed}`,
        `package name: expected "elepha", observed ${value(failure.packageName)}`,
        `engines.node: expected ${expectedEngine}, observed ${value(failure.enginesNode)}`,
        `node version: expected ${expectedNodeVersion}, observed ${failure.nodeVersion}`,
        `process.execPath: expected not constrained, observed ${failure.execPath}`,
        `bin.elepha: expected not constrained, observed ${value(failure.declaredBin)}`,
        `resolved package root: expected readable package root, observed ${failure.packageRoot}`,
    ].join('\n');
}

// The launcher verifies that the currently running package is elepha and the
// selected Node version can run it. The launcher separately owns Node discovery.
export function launcherProbe(minimum: string): LauncherProbeResult {
    const expected = `>=${minimum}`;
    const execPath = process.execPath;
    const nodeVersion = process.versions.node;
    let packageRoot = 'unresolved';
    let packageName: unknown;
    let enginesNode: unknown;
    let declaredBin: unknown;
    const details = () => ({ packageName, enginesNode, nodeVersion, execPath, declaredBin, packageRoot, minimum });
    try {
        const minimumParts = /^\d+\.\d+\.\d+$/.test(minimum) ? minimum.split('.').map(Number) : undefined;
        if (!minimumParts) {
            return failed('minimum version', 'semantic version', minimum, details());
        }
        // URL.pathname leaves percent escapes intact, including Herd's
        // "Application Support" path. Convert the URL before deriving paths.
        const moduleFile = fileURLToPath(import.meta.url);
        packageRoot = realpathSync(path.resolve(path.dirname(moduleFile), '..', '..'));
        const packageJson = path.join(packageRoot, 'package.json');
        const manifest = JSON.parse(readFileSync(packageJson, 'utf8')) as {
            name?: unknown;
            engines?: { node?: unknown };
            bin?: unknown;
        };
        packageName = manifest.name;
        enginesNode = manifest.engines?.node;
        declaredBin =
            manifest.bin && typeof manifest.bin === 'object' && !Array.isArray(manifest.bin)
                ? (manifest.bin as Record<string, unknown>).elepha
                : undefined;
        if (packageName !== 'elepha') {
            return failed('package name', '"elepha"', value(packageName), details());
        }
        if (enginesNode !== expected) {
            return failed('engines.node', expected, value(enginesNode), details());
        }
        const nodeParts = nodeVersion.split('.').map(Number);
        if (
            nodeParts[0] < minimumParts[0] ||
            (nodeParts[0] === minimumParts[0] && nodeParts[1] < minimumParts[1]) ||
            (nodeParts[0] === minimumParts[0] && nodeParts[1] === minimumParts[1] && nodeParts[2] < minimumParts[2])
        ) {
            return failed('node version', `>=${minimum}`, nodeVersion, details());
        }
        return { passes: true };
    } catch (error) {
        return failed('package resolution', 'readable installed elepha package', errorMessage(error), details());
    }
}
