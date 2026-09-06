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
    requiredMinimum?: string;
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
    const semanticMinimum = /^\d+\.\d+\.\d+$/.test(failure.minimum);
    const legacyMajor = /^[1-9]\d*$/.test(failure.minimum);
    const expectedEngine = semanticMinimum
        ? `>=${failure.minimum}`
        : legacyMajor
          ? `canonical >=${failure.minimum}.N.N`
          : 'canonical >=N.N.N';
    const expectedNodeVersion = failure.requiredMinimum
        ? `>=${failure.requiredMinimum}`
        : semanticMinimum
          ? `>=${failure.minimum}`
          : 'semantic version';
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
    const execPath = process.execPath;
    const nodeVersion = process.versions.node;
    let packageRoot = 'unresolved';
    let packageName: unknown;
    let enginesNode: unknown;
    let declaredBin: unknown;
    let requiredMinimum: string | undefined;
    const details = () => ({ packageName, enginesNode, nodeVersion, execPath, declaredBin, packageRoot, minimum, requiredMinimum });
    try {
        const semanticMinimum = /^\d+\.\d+\.\d+$/.test(minimum) ? minimum : undefined;
        // 0.3.x launchers supplied only the major. The installed package's
        // canonical engine floor still owns the complete Node version check.
        const legacyMinimumMajor = /^[1-9]\d*$/.test(minimum) ? Number(minimum) : undefined;
        if (!semanticMinimum && legacyMinimumMajor === undefined) {
            return failed('minimum version', 'semantic version or legacy major', minimum, details());
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
        const engineMatch = typeof enginesNode === 'string' ? /^>=(\d+\.\d+\.\d+)$/.exec(enginesNode) : null;
        if (!engineMatch) {
            return failed('engines.node', 'canonical >=N.N.N', value(enginesNode), details());
        }
        requiredMinimum = engineMatch[1];
        if (semanticMinimum ? requiredMinimum !== semanticMinimum : Number(requiredMinimum.split('.')[0]) !== legacyMinimumMajor) {
            const expected = semanticMinimum ? `>=${semanticMinimum}` : `canonical >=${legacyMinimumMajor}.N.N`;
            return failed('engines.node', expected, value(enginesNode), details());
        }
        const minimumParts = requiredMinimum.split('.').map(Number);
        const nodeParts = nodeVersion.split('.').map(Number);
        if (
            nodeParts[0] < minimumParts[0] ||
            (nodeParts[0] === minimumParts[0] && nodeParts[1] < minimumParts[1]) ||
            (nodeParts[0] === minimumParts[0] && nodeParts[1] === minimumParts[1] && nodeParts[2] < minimumParts[2])
        ) {
            return failed('node version', `>=${requiredMinimum}`, nodeVersion, details());
        }
        return { passes: true };
    } catch (error) {
        return failed('package resolution', 'readable installed elepha package', errorMessage(error), details());
    }
}
