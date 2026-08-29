// Runs the actual Biome plugins (.biome-plugins/*.grit) against frozen
// fixtures, so a change that silently weakens or breaks the plugins - a
// syntax error, a glob typo, a regressed false-positive guard - fails CI
// instead of shipping a security check that always passes. A check that
// always passes is the same failure shape as the parser that silently
// returned EMPTY_OUTPUT for 3,325 rows: both look like a clean pass and both mean nothing was
// actually verified.

import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '../..');
const UNSAFE_FIXTURE = path.join(REPO_ROOT, 'test/fixtures/biome-plugin/src/unsafe-subprocess-calls.ts');
const SAFE_FIXTURE = path.join(REPO_ROOT, 'test/fixtures/biome-plugin/src/safe-builtin-methods.ts');
const BIOME_BIN = path.join(REPO_ROOT, 'node_modules/.bin/biome');

interface BiomeDiagnostic {
    severity: string;
    message: string;
    category: string;
    location: { path: string; start: { line: number; column: number } };
}

interface BiomeCheckResult {
    diagnostics: BiomeDiagnostic[];
}

/**
 * Runs the real .biome-plugins/*.grit files (referenced by absolute path, not
 * copied - so this can never silently drift from what actually ships) against
 * one fixture, in an isolated scratch dir. Isolation is required, not just
 * tidy: this repo's own root biome.json is a "root" config, and running
 * biome anywhere under this repo's tree makes it refuse to apply a second,
 * different config ("Found a nested root configuration, but there's already
 * a root configuration") - the fixture would otherwise have to live under the
 * real project config, which is exactly what we don't want it silently doing.
 */
function runBiomeCheck(fixturePath: string): BiomeCheckResult {
    const scratchDir = mkdtempSync(path.join(tmpdir(), 'elepha-biome-plugin-fixture-'));
    try {
        const srcDir = path.join(scratchDir, 'src');
        mkdirSync(srcDir);
        const fixtureName = path.basename(fixturePath);
        copyFileSync(fixturePath, path.join(srcDir, fixtureName));

        const noRawSubprocess = path.join(REPO_ROOT, '.biome-plugins/no-raw-subprocess.grit');
        const noShellTrue = path.join(REPO_ROOT, '.biome-plugins/no-shell-true.grit');
        writeFileSync(
            path.join(scratchDir, 'biome.json'),
            JSON.stringify({
                files: { includes: ['**'] },
                formatter: { enabled: false },
                // NOT `linter: { enabled: false }` - confirmed by direct
                // experiment that disabling the linter also silently
                // disables ALL plugin diagnostics in this Biome version,
                // undocumented. Leaving the linter on and filtering to
                // category === 'plugin' below is what actually exercises
                // the plugins; the earlier version of this test had
                // linter disabled and passed vacuously - a check that
                // always passes, exactly what it exists to prevent.
                plugins: [
                    { path: noRawSubprocess, includes: ['**/src/**'] },
                    { path: noShellTrue, includes: ['**/src/**'] },
                ],
            }),
        );

        let stdout: string;
        try {
            stdout = execFileSync(BIOME_BIN, ['check', '--reporter=json', `src/${fixtureName}`], {
                cwd: scratchDir,
                stdio: ['ignore', 'pipe', 'ignore'],
            }).toString('utf8');
        } catch (err) {
            // biome exits non-zero when it finds errors - expected for the unsafe fixture.
            stdout = (err as { stdout?: Buffer }).stdout?.toString('utf8') ?? '';
        }
        return JSON.parse(stdout) as BiomeCheckResult;
    } finally {
        rmSync(scratchDir, { recursive: true, force: true });
    }
}

function pluginDiagnostics(result: BiomeCheckResult): BiomeDiagnostic[] {
    return result.diagnostics.filter((d) => d.category === 'plugin');
}

describe('Biome security plugins, run for real against fixtures', () => {
    it('no-raw-subprocess.grit fires on a bare call, a member-expression call, AND no-shell-true.grit fires on shell:true, all in one file', () => {
        const diagnostics = pluginDiagnostics(runBiomeCheck(UNSAFE_FIXTURE));

        const subprocessBan = diagnostics.filter((d) => d.message.includes('Subprocess calls are only allowed in'));
        const shellTrueBan = diagnostics.filter((d) => d.message.includes('shell: true is banned'));

        // bareCall (execSync, line 11) + memberCall (cp.exec, line 16) +
        // shellTrue's own spawn(...) call (line 21, banned regardless of the
        // shell:true option) = 3 hits from no-raw-subprocess.grit.
        expect(subprocessBan).toHaveLength(3);
        expect(subprocessBan.map((d) => d.location.start.line).sort()).toEqual([11, 16, 21]);

        // shellTrue also trips no-shell-true.grit independently on the same
        // line (defense in depth: banning the call AND the option, not just
        // one) - four plugin diagnostics total on this file.
        expect(shellTrueBan).toHaveLength(1);
        expect(shellTrueBan[0]!.location.start.line).toBe(21);
        expect(diagnostics).toHaveLength(4);
    });

    it('regression guard: RegExp.prototype.exec and a Database-shaped .exec method do NOT trigger the plugin', () => {
        const diagnostics = pluginDiagnostics(runBiomeCheck(SAFE_FIXTURE));
        expect(diagnostics).toEqual([]);
    });
});
