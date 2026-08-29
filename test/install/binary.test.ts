import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { hookCommand, resolveInstalledElephaBin } from '../../src/install/binary.js';

function installedBin(name = 'prefix'): { root: string; shim: string; bin: string } {
    const root = mkdtempSync(path.join(tmpdir(), 'elepha bin '));
    const packageRoot = path.join(root, 'lib', 'node_modules', 'elepha');
    const bin = path.join(packageRoot, 'bin', 'elepha.js');
    mkdirSync(path.dirname(bin), { recursive: true });
    writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({ name: 'elepha', bin: { elepha: './bin/elepha.js' } }));
    writeFileSync(bin, '#!/usr/bin/env node\n');
    chmodSync(bin, 0o755);
    const directory = path.join(root, name);
    mkdirSync(directory, { recursive: true });
    const shim = path.join(directory, 'elepha');
    symlinkSync(bin, shim);
    return { root, shim, bin };
}

describe('installed npm binary resolution', () => {
    it('returns the stable first PATH shim, not its package-store target', () => {
        const first = installedBin('first');
        const second = installedBin('second');
        expect(resolveInstalledElephaBin({ pathValue: `${first.root}/first:${second.root}/second`, argvEntrypoint: second.bin }).bin).toBe(
            first.shim,
        );
    });

    it('uses an installed argv bin only when PATH has no valid candidate and quotes hook paths safely', () => {
        const fixture = installedBin("npm's bin");
        expect(resolveInstalledElephaBin({ pathValue: '', argvEntrypoint: fixture.bin }).bin).toBe(fixture.bin);
        expect(hookCommand("/tmp/npm's bin/elepha", 'codex')).toBe("'/tmp/npm'\\''s bin/elepha' hook session-start --tool codex");
    });

    it('refuses a checkout executable and win32 before mutation', () => {
        const checkout = mkdtempSync(path.join(tmpdir(), 'elepha checkout-'));
        const dist = path.join(checkout, 'dist', 'cli', 'index.js');
        mkdirSync(path.dirname(dist), { recursive: true });
        writeFileSync(dist, '');
        chmodSync(dist, 0o755);
        expect(() => resolveInstalledElephaBin({ pathValue: '', argvEntrypoint: dist })).toThrow('npm-installed');
        expect(() => resolveInstalledElephaBin({ platform: 'win32' })).toThrow('not supported');
    });
});
