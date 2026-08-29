import { chmodSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { detectLauncherBackend, renderLauncher } from '../../src/install/launcher.js';

const fsFixture = vi.hoisted(() => ({ preserveDistroExecPath: false }));

vi.mock('node:fs', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:fs')>();
    const realpath = actual.realpathSync as (file: string) => string;
    return {
        ...actual,
        realpathSync: (file: string) => (fsFixture.preserveDistroExecPath && file === '/usr/bin/node' ? file : realpath(file)),
    };
});

interface NvmFixtureOptions {
    defaultAlias?: string;
    versions?: string[];
    activeVersion?: string;
}

function nvmFixture({ defaultAlias = '22', versions = ['v22.2.1'], activeVersion = 'v22.2.1' }: NvmFixtureOptions = {}): {
    root: string;
    node: string;
    packageRoot: string;
    sourceBin: string;
} {
    const root = mkdtempSync(path.join(tmpdir(), 'elepha-nvm-'));
    const node = path.join(root, 'versions', 'node', activeVersion, 'bin', 'node');
    const packageRoot = path.join(root, 'global', 'lib', 'node_modules', 'elepha');
    const sourceBin = path.join(root, 'global', 'bin', 'elepha');
    for (const version of versions) {
        const installedNode = path.join(root, 'versions', 'node', version, 'bin', 'node');
        mkdirSync(path.dirname(installedNode), { recursive: true });
        writeFileSync(installedNode, 'node');
        chmodSync(installedNode, 0o755);
    }
    mkdirSync(path.join(root, 'alias'), { recursive: true });
    mkdirSync(path.dirname(sourceBin), { recursive: true });
    mkdirSync(packageRoot, { recursive: true });
    writeFileSync(path.join(root, 'nvm-exec'), '#!/bin/sh\n');
    writeFileSync(path.join(root, 'nvm.sh'), '# nvm\n');
    writeFileSync(path.join(root, 'alias', 'default'), `${defaultAlias}\n`);
    writeFileSync(sourceBin, '#!/bin/sh\n');
    writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({ name: 'elepha', engines: { node: '>=22' } }));
    chmodSync(path.join(root, 'nvm-exec'), 0o755);
    chmodSync(sourceBin, 0o755);
    return { root, node, packageRoot, sourceBin };
}

describe('stable launcher backend', () => {
    it('resolves fnm from PATH for a Linux-style installation', () => {
        const fixture = mkdtempSync(path.join(tmpdir(), 'elepha-fnm-linux-'));
        const root = path.join(fixture, 'fnm-data');
        const node = path.join(root, 'node-versions', 'v22.2.1', 'installation', 'bin', 'node');
        const managerBin = path.join(fixture, 'local', 'bin');
        const fnm = path.join(managerBin, 'fnm');
        const packageRoot = path.join(fixture, 'package');

        for (const file of [node, fnm]) {
            mkdirSync(path.dirname(file), { recursive: true });
            writeFileSync(file, '#!/bin/sh\n');
            chmodSync(file, 0o755);
        }
        mkdirSync(path.join(root, 'aliases'), { recursive: true });
        writeFileSync(path.join(root, 'aliases', 'default'), 'v22.2.1\n');
        mkdirSync(packageRoot, { recursive: true });
        writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({ engines: { node: '>=22' } }));

        expect(
            detectLauncherBackend({
                execPath: node,
                env: { PATH: [path.join(fixture, 'missing'), managerBin].join(path.delimiter) },
                packageRoot,
                sourceBin: path.join(fixture, 'global', 'bin', 'elepha'),
                minimumNodeMajor: 22,
            }),
        ).toEqual({ kind: 'fnm', command: fnm, root: realpathSync(root) });
    });

    it('resolves asdf from PATH for a Linux-style installation', () => {
        const fixture = mkdtempSync(path.join(tmpdir(), 'elepha-asdf-linux-'));
        const root = path.join(fixture, 'asdf-data');
        const home = path.join(fixture, 'home');
        const node = path.join(root, 'installs', 'nodejs', '22.2.1', 'bin', 'node');
        const shim = path.join(root, 'shims', 'elepha');
        const managerBin = path.join(fixture, 'local', 'bin');
        const asdf = path.join(managerBin, 'asdf');
        const packageRoot = path.join(fixture, 'package');

        for (const file of [node, shim, asdf]) {
            mkdirSync(path.dirname(file), { recursive: true });
            writeFileSync(file, '#!/bin/sh\n');
            chmodSync(file, 0o755);
        }
        mkdirSync(home, { recursive: true });
        writeFileSync(path.join(home, '.tool-versions'), 'nodejs 22.2.1\n');
        mkdirSync(packageRoot, { recursive: true });
        writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({ engines: { node: '>=22' } }));

        expect(
            detectLauncherBackend({
                execPath: node,
                env: { PATH: [path.join(fixture, 'missing'), managerBin].join(path.delimiter) },
                home,
                packageRoot,
                sourceBin: path.join(fixture, 'global', 'bin', 'elepha'),
                minimumNodeMajor: 22,
            }),
        ).toEqual({ kind: 'asdf', command: asdf, root: realpathSync(root) });
    });

    it('resolves a Linux distro Node path as standalone', () => {
        const fixture = mkdtempSync(path.join(tmpdir(), 'elepha-distro-node-'));
        const packageRoot = path.join(fixture, 'package');
        mkdirSync(packageRoot, { recursive: true });
        writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({ engines: { node: '>=22' } }));
        fsFixture.preserveDistroExecPath = true;

        try {
            expect(
                detectLauncherBackend({
                    execPath: '/usr/bin/node',
                    env: { PATH: '/usr/bin' },
                    packageRoot,
                    sourceBin: '/usr/bin/elepha',
                    minimumNodeMajor: 22,
                }),
            ).toEqual({ kind: 'standalone', command: '/usr/bin/elepha', node: '/usr/bin/node', npmBin: '/usr/bin' });
        } finally {
            fsFixture.preserveDistroExecPath = false;
        }
    });

    it('selects nvm from the active runtime and renders only stable control paths', () => {
        const fixture = nvmFixture();
        const backend = detectLauncherBackend({
            execPath: fixture.node,
            packageRoot: fixture.packageRoot,
            sourceBin: fixture.sourceBin,
            minimumNodeMajor: 22,
        });

        const canonicalRoot = realpathSync(fixture.root);
        expect(backend).toEqual({ kind: 'nvm', command: path.join(canonicalRoot, 'nvm-exec'), root: canonicalRoot });
        const launcher = renderLauncher(backend, 22);
        expect(launcher).toContain('#!/bin/sh');
        expect(launcher).toContain('set -eu');
        expect(launcher).toContain('NODE_VERSION=default');
        expect(launcher).toContain(path.join(fixture.root, 'nvm-exec'));
        expect(launcher).not.toContain('/versions/node/v22.2.1');
        expect(launcher).toContain('"$@"');
    });

    it('refuses a non-default active runtime before any installer write', () => {
        const fixture = nvmFixture({
            defaultAlias: '22',
            versions: ['v22.23.2', 'v24.19.0'],
            activeVersion: 'v24.19.0',
        });
        expect(() =>
            detectLauncherBackend({
                execPath: fixture.node,
                packageRoot: fixture.packageRoot,
                sourceBin: fixture.sourceBin,
                minimumNodeMajor: 22,
            }),
        ).toThrow('default resolves to v22.23.2, active is v24.19.0');
    });

    it('accepts Herd nvm bare-major default aliases when the active runtime is the highest matching install', () => {
        const fixture = nvmFixture({
            defaultAlias: '24',
            versions: ['v22.23.2', 'v24.19.0'],
            activeVersion: 'v24.19.0',
        });

        expect(
            detectLauncherBackend({
                execPath: fixture.node,
                packageRoot: fixture.packageRoot,
                sourceBin: fixture.sourceBin,
                minimumNodeMajor: 22,
            }),
        ).toMatchObject({ kind: 'nvm' });
    });

    it('resolves every supported nvm alias form to the active installed runtime', () => {
        const cases = [
            { name: 'bare major', defaultAlias: '24', versions: ['v24.9.0', 'v24.19.0'], activeVersion: 'v24.19.0' },
            {
                name: 'major minor',
                defaultAlias: '24.19',
                versions: ['v24.18.9', 'v24.19.0', 'v24.19.2'],
                activeVersion: 'v24.19.2',
            },
            {
                name: 'exact version',
                defaultAlias: 'v24.19.0',
                versions: ['v24.19.0', 'v24.19.2'],
                activeVersion: 'v24.19.0',
            },
            { name: 'node', defaultAlias: 'node', versions: ['v24.19.0', 'v24.19.2'], activeVersion: 'v24.19.2' },
            { name: 'lts', defaultAlias: 'lts/iron', versions: ['v24.19.0'], activeVersion: 'v24.19.0' },
        ];

        for (const testCase of cases) {
            const fixture = nvmFixture(testCase);
            if (testCase.name === 'lts') {
                mkdirSync(path.join(fixture.root, 'alias', 'lts'), { recursive: true });
                writeFileSync(path.join(fixture.root, 'alias', 'lts', 'iron'), 'v24.19.0\n');
            }

            expect(
                detectLauncherBackend({
                    execPath: fixture.node,
                    packageRoot: fixture.packageRoot,
                    sourceBin: fixture.sourceBin,
                    minimumNodeMajor: 22,
                }),
                testCase.name,
            ).toMatchObject({ kind: 'nvm' });
        }
    });

    it('rejects unresolved nvm aliases and alias cycles', () => {
        const cases = [
            { name: 'unresolved bare major', defaultAlias: '23', aliases: [] },
            {
                name: 'alias cycle',
                defaultAlias: 'first',
                aliases: [
                    ['first', 'second'],
                    ['second', 'first'],
                ],
            },
        ] as const;

        for (const testCase of cases) {
            const fixture = nvmFixture({
                defaultAlias: testCase.defaultAlias,
                versions: ['v22.23.2', 'v24.19.0'],
                activeVersion: 'v24.19.0',
            });
            for (const [alias, target] of testCase.aliases) {
                writeFileSync(path.join(fixture.root, 'alias', alias), `${target}\n`);
            }

            expect(
                () =>
                    detectLauncherBackend({
                        execPath: fixture.node,
                        packageRoot: fixture.packageRoot,
                        sourceBin: fixture.sourceBin,
                        minimumNodeMajor: 22,
                    }),
                testCase.name,
            ).toThrow('default resolves to no installed version, active is v24.19.0');
        }
    });
});
