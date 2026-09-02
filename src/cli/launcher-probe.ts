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
    nodeMajor: number;
    execPath: string;
    declaredBin: unknown;
    packageRoot: string;
    minimum: number;
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
    const expectedEngine = Number.isInteger(failure.minimum) && failure.minimum > 0 ? `>=${failure.minimum}` : 'canonical >=N';
    const expectedNodeMajor = Number.isInteger(failure.minimum) && failure.minimum > 0 ? `>=${failure.minimum}` : 'positive integer';
    return [
        `launcher probe failed: ${failure.check}`,
        `expected: ${failure.expected}`,
        `observed: ${failure.observed}`,
        `package name: expected "elepha", observed ${value(failure.packageName)}`,
        `engines.node: expected ${expectedEngine}, observed ${value(failure.enginesNode)}`,
        `node major: expected ${expectedNodeMajor}, observed ${failure.nodeMajor}`,
        `process.execPath: expected not constrained, observed ${failure.execPath}`,
        `bin.elepha: expected not constrained, observed ${value(failure.declaredBin)}`,
        `resolved package root: expected readable package root, observed ${failure.packageRoot}`,
    ].join('\n');
}

// The launcher verifies that the currently running package is elepha and the
// selected Node major can run it. The launcher separately owns Node discovery.
export function launcherProbe(minimum: number): LauncherProbeResult {
    const expected = `>=${minimum}`;
    const execPath = process.execPath;
    const nodeVersion = process.versions.node;
    const nodeMajor = Number(nodeVersion.split('.')[0]);
    let packageRoot = 'unresolved';
    let packageName: unknown;
    let enginesNode: unknown;
    let declaredBin: unknown;
    const details = () => ({ packageName, enginesNode, nodeMajor, execPath, declaredBin, packageRoot, minimum });
    try {
        if (!Number.isInteger(minimum) || minimum < 1) {
            return failed('minimum major', 'positive integer', String(minimum), details());
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
        if (nodeMajor < minimum) {
            return failed('node major', `>=${minimum}`, String(nodeMajor), details());
        }
        return { passes: true };
    } catch (error) {
        return failed('package resolution', 'readable installed elepha package', errorMessage(error), details());
    }
}
