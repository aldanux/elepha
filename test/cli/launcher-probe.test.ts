import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function npm(args: string[]): string {
    return String(execFileSync('npm', args, { cwd: repositoryRoot, encoding: 'utf8' }));
}

function runProbe(bin: string, minimum: number) {
    return spawnSync(bin, ['internal', 'launcher-probe', String(minimum)], { encoding: 'utf8' });
}

function runVersion(bin: string) {
    return spawnSync(bin, ['--version'], { encoding: 'utf8' });
}

describe('launcher probe', () => {
    it('runs from a real packed global installation and rejects invalid installed manifests', () => {
        const root = mkdtempSync(path.join(tmpdir(), 'elepha-launcher-probe-'));
        const packDirectory = path.join(root, 'pack');
        const prefix = path.join(root, 'prefix');
        try {
            mkdirSync(packDirectory);
            npm(['run', 'build']);
            const [{ filename }] = JSON.parse(npm(['pack', '--json', '--pack-destination', packDirectory])) as Array<{ filename: string }>;
            npm(['install', '--global', '--prefix', prefix, '--no-audit', '--no-fund', path.join(packDirectory, filename)]);

            const bin = path.join(prefix, 'bin', 'elepha');
            const packageJson = path.join(prefix, 'lib', 'node_modules', 'elepha', 'package.json');
            const original = JSON.parse(readFileSync(packageJson, 'utf8')) as { name: string; version: string; engines: { node: string } };

            expect(runProbe(bin, 22).status).toBe(0);
            expect(runVersion(bin)).toMatchObject({ status: 0, stdout: `${original.version}\n` });

            writeFileSync(packageJson, JSON.stringify({ ...original, name: 'not-elepha' }));
            const wrongName = runProbe(bin, 22);
            expect(wrongName.status).toBe(66);
            expect(wrongName.stderr).toContain('launcher probe failed: package name');
            expect(wrongName.stderr).toContain('package name: expected "elepha", observed "not-elepha"');
            expect(wrongName.stderr).toContain('engines.node: expected >=22, observed ">=22"');
            expect(wrongName.stderr).toContain(`node major: expected >=22, observed ${process.versions.node.split('.')[0]}`);
            expect(wrongName.stderr).toContain('process.execPath: expected not constrained, observed ');
            expect(wrongName.stderr).toContain('bin.elepha: expected not constrained, observed "./bin/elepha.js"');
            expect(wrongName.stderr).toContain('resolved package root: expected readable package root, observed ');

            writeFileSync(packageJson, JSON.stringify({ ...original, engines: { node: '^22' } }));
            const badEngine = runProbe(bin, 22);
            expect(badEngine.status).toBe(66);
            expect(badEngine.stderr).toContain('launcher probe failed: engines.node');

            writeFileSync(packageJson, JSON.stringify({ ...original, engines: { node: '>=25' } }));
            const oldNode = runProbe(bin, 25);
            expect(oldNode.status).toBe(66);
            expect(oldNode.stderr).toContain('launcher probe failed: node major');
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    }, 30000);
});
