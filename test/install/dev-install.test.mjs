import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withTempDir } from '../helpers/tmp.js';

const mock = vi.hoisted(() => ({ calls: [], respond: undefined, execPath: '', launcher: '', detect: vi.fn() }));
vi.mock('node:fs', async (original) => {
    const fs = await original();
    return { ...fs, realpathSync: (file) => (file === process.execPath ? mock.execPath : fs.realpathSync(file)) };
});
vi.mock('tsx/esm/api', () => ({
    tsImport: async (specifier) =>
        specifier.includes('launcher.ts') ? { detectLauncherBackend: mock.detect } : { elephaLauncherPath: () => mock.launcher },
}));
vi.mock('node:child_process', () => ({
    spawn: (command, args, options) => {
        mock.calls.push({ command, args, env: { ...options.env } });
        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stdout.setEncoding = () => {};
        queueMicrotask(() => {
            const response = mock.respond(command, args);
            if (response.stdout) child.stdout.emit('data', response.stdout);
            child.emit('close', response.status ?? 0, null);
        });
        return child;
    },
}));

const { main } = await import('../../scripts/dev-install.mjs');
const checkout = path.resolve(import.meta.dirname, '../..');
const savedEnvironment = { ...process.env };
let root;
let prefix;
let tarball;

beforeEach(() => {
    root = withTempDir('elepha-dev-install-');
    prefix = path.join(root, 'prefix');
    mkdirSync(path.join(prefix, 'bin'), { recursive: true });
    tarball = path.join(checkout, `${path.basename(root)}.tgz`);
    mock.execPath = '/usr/bin/node';
    mock.launcher = path.join(root, 'managed', 'elepha');
    mock.calls = [];
    mock.detect.mockReset().mockReturnValue({ kind: 'standalone', node: '/usr/bin/node' });
    process.env.PATH = path.join(prefix, 'bin');
    delete process.env.ELEPHA_DEV_INSTALL_REEXEC;
    mock.respond = (_command, args) => {
        if (args[0] === 'prefix') return { stdout: `${prefix}\n` };
        if (args[0] === 'pack') {
            writeFileSync(tarball, 'fixture tarball');
            return { stdout: `${path.basename(tarball)}\n` };
        }
        return {};
    };
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(process.stdout, 'write').mockReturnValue(true);
});

afterEach(() => {
    process.env = { ...savedEnvironment };
    vi.restoreAllMocks();
    expect(existsSync(tarball)).toBe(false);
});

function existingBinary() {
    const bin = path.join(prefix, 'bin', 'elepha');
    writeFileSync(bin, '#!/bin/sh\n', { mode: 0o755 });
    return bin;
}

describe('maintainer dev install', () => {
    it('builds, packs, uninstalls, installs the real tarball, removes it, installs integrations, and runs doctor', async () => {
        const bin = existingBinary();
        await main();
        expect(mock.calls.map(({ args }) => args)).toEqual([
            ['prefix', '-g'],
            ['run', 'build'],
            ['pack'],
            ['--version'],
            ['uninstall'],
            ['install', '-g', `./${path.basename(tarball)}`],
            ['install'],
            ['doctor'],
        ]);
        expect(mock.calls.at(-1).command).toBe(bin);
        expect(process.stdout.write).toHaveBeenCalledWith(`${path.basename(tarball)}\n`);
    });

    it.each(['--version', 'uninstall'])('recovers through the fresh checkout when the old %s fails', async (failed) => {
        existingBinary();
        const respond = mock.respond;
        mock.respond = (command, args) => (args[0] === failed ? { status: 66 } : respond(command, args));
        await main();
        expect(mock.calls.some(({ command, args }) => command === process.execPath && args[1] === 'uninstall')).toBe(true);
        expect(mock.calls.at(-1).args).toEqual(['doctor']);
    });

    it.each(['build', 'global install', 'doctor', 'checkout uninstall'])('stops and reports failure at %s', async (failed) => {
        existingBinary();
        const respond = mock.respond;
        mock.respond = (command, args) => {
            if (
                (failed === 'build' && args[1] === 'build') ||
                (failed === 'global install' && args[1] === '-g' && args[0] === 'install') ||
                (failed === 'doctor' && args[0] === 'doctor') ||
                (failed === 'checkout uninstall' && (args[0] === '--version' || args[1] === 'uninstall'))
            )
                return { status: 1 };
            return respond(command, args);
        };
        await expect(main()).rejects.toThrow('failed');
        if (failed !== 'doctor') expect(mock.calls.some(({ args }) => args[0] === 'doctor')).toBe(false);
    });

    it('reruns a mismatched nvm shell through nvm-exec with the default alias and a recursion guard', async () => {
        const nvm = path.join(root, 'nvm with spaces');
        mkdirSync(nvm);
        writeFileSync(path.join(nvm, 'nvm-exec'), '#!/bin/sh\n', { mode: 0o755 });
        writeFileSync(path.join(nvm, 'nvm.sh'), '');
        mock.execPath = path.join(nvm, 'versions', 'node', 'v22.12.0', 'bin', 'node');
        mock.detect.mockImplementation(() => {
            throw new Error('default resolves to v24, active is v22');
        });
        await main();
        expect(mock.calls).toEqual([
            expect.objectContaining({
                command: path.join(nvm, 'nvm-exec'),
                args: ['node', path.join(checkout, 'scripts', 'dev-install.mjs')],
                env: expect.objectContaining({ NVM_DIR: nvm, NODE_VERSION: 'default', ELEPHA_DEV_INSTALL_REEXEC: '1' }),
            }),
        ]);
    });

    it('refuses a mismatched fnm default before building', async () => {
        const otherNode = path.join(root, 'other-node');
        writeFileSync(otherNode, 'node');
        mock.detect.mockReturnValue({ kind: 'fnm', command: '/tools/fnm', root });
        const respond = mock.respond;
        mock.respond = (command, args) => (command === '/tools/fnm' ? { stdout: `${otherNode}\n` } : respond(command, args));
        await expect(main()).rejects.toThrow('Run: fnm use default && npm run dev:install');
        expect(mock.calls.some(({ args }) => args[1] === 'build')).toBe(false);
    });

    it('reports an unavailable fnm default with its setup command', async () => {
        mock.detect.mockReturnValue({ kind: 'fnm', command: '/tools/fnm', root });
        const respond = mock.respond;
        mock.respond = (command, args) => (command === '/tools/fnm' ? { status: 1 } : respond(command, args));
        await expect(main()).rejects.toThrow('Run: fnm default 24 && fnm use default && npm run dev:install');
    });

    it('uses the existing asdf home default in its mismatch guidance', async () => {
        process.env.HOME = root;
        writeFileSync(path.join(root, '.tool-versions'), 'nodejs 24.19.0\n');
        mock.execPath = path.join(root, 'installs/nodejs/22.12.0/bin/node');
        await expect(main()).rejects.toThrow('Run: ASDF_NODEJS_VERSION=24.19.0 npm run dev:install');
        expect(mock.calls.some(({ args }) => args[1] === 'build')).toBe(false);
    });

    it('accepts a first asdf installation without an existing elepha shim and reshims before install', async () => {
        process.env.HOME = root;
        writeFileSync(path.join(root, '.tool-versions'), 'nodejs 24.19.0\n');
        mock.execPath = path.join(root, 'installs/nodejs/24.19.0/bin/node');
        writeFileSync(path.join(prefix, 'bin', 'asdf'), '#!/bin/sh\n', { mode: 0o755 });
        await main();
        expect(mock.calls.slice(-3).map(({ args }) => args)).toEqual([['reshim', 'nodejs'], ['install'], ['doctor']]);
    });

    it('gives actionable nvm guidance instead of recursively rerunning a broken default', async () => {
        mock.execPath = path.join(root, 'versions', 'node', 'v22.12.0', 'bin', 'node');
        mock.detect.mockImplementation(() => {
            throw new Error('default missing');
        });
        process.env.ELEPHA_DEV_INSTALL_REEXEC = '1';
        await expect(main()).rejects.toThrow('Run: nvm use default && npm run dev:install');
        expect(mock.calls).toEqual([]);
    });
});
