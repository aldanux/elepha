import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { npmPostinstallFailureMessage, npmPostinstallRetiredMessage, runNpmPostinstall } from '../../src/install/npm-postinstall.js';
import { withGrantableTestDir } from '../helpers/tmp.js';

function fixture() {
    const root = withGrantableTestDir('npm-postinstall-');
    const prefix = path.join(root, 'npm with spaces');
    const packageRoot = path.join(prefix, 'lib', 'node_modules', 'elepha');
    const bin = path.join(packageRoot, 'bin', 'elepha.js');
    const manifest = path.join(packageRoot, 'package.json');
    mkdirSync(path.dirname(bin), { recursive: true });
    mkdirSync(path.join(prefix, 'bin'));
    writeFileSync(bin, '// installed elepha entrypoint\n');
    chmodSync(bin, 0o755);
    symlinkSync(bin, path.join(prefix, 'bin', 'elepha'));
    writeFileSync(manifest, JSON.stringify({ name: 'elepha', type: 'module', bin: { elepha: './bin/elepha.js' } }));
    const database = path.join(root, 'elepha.db');
    const env = {
        npm_config_global: 'true',
        npm_lifecycle_event: 'postinstall',
        npm_package_name: 'elepha',
        npm_package_json: manifest,
        npm_config_global_prefix: prefix,
    };
    const databasePath = vi.fn(() => database);
    const retireReaders = vi.fn(async () => 0);
    const report = vi.fn();
    return {
        root,
        prefix,
        packageRoot,
        database,
        env,
        databasePath,
        retireReaders,
        report,
        runtime: { env, cwd: packageRoot, databasePath, retireReaders, report },
    };
}

describe('global npm postinstall bootstrap', () => {
    it.each([
        { npm_config_global: undefined },
        { npm_config_global: 'false' },
        { npm_config_global: '1' },
        { npm_lifecycle_event: 'install' },
        { npm_package_name: 'other-package' },
    ])('does not inspect local memory for an unrelated lifecycle: %j', async (changes) => {
        const test = fixture();
        await expect(runNpmPostinstall(test.packageRoot, { ...test.runtime, env: { ...test.env, ...changes } })).resolves.toBe(0);
        expect(test.databasePath).not.toHaveBeenCalled();
        expect(test.retireReaders).not.toHaveBeenCalled();
        expect(test.report).not.toHaveBeenCalled();
    });

    it('does not inspect memory on unsupported platforms', async () => {
        const test = fixture();
        await expect(runNpmPostinstall(test.packageRoot, { ...test.runtime, platform: 'win32' })).resolves.toBe(0);
        expect(test.databasePath).not.toHaveBeenCalled();
        expect(test.report).not.toHaveBeenCalled();
    });

    it('does not mistake a repository entrypoint or cwd for the global installed package', async () => {
        const test = fixture();
        await expect(runNpmPostinstall(test.root, test.runtime)).resolves.toBe(0);
        await expect(runNpmPostinstall(test.packageRoot, { ...test.runtime, cwd: test.root })).resolves.toBe(0);
        expect(test.databasePath).not.toHaveBeenCalled();
        expect(test.report).not.toHaveBeenCalled();
    });

    it('refuses npm link even when the environment names a global package', async () => {
        const test = fixture();
        const linkPrefix = path.join(test.root, 'linked-prefix');
        mkdirSync(path.join(linkPrefix, 'lib', 'node_modules'), { recursive: true });
        symlinkSync(test.packageRoot, path.join(linkPrefix, 'lib', 'node_modules', 'elepha'));
        await expect(
            runNpmPostinstall(test.packageRoot, {
                ...test.runtime,
                env: { ...test.env, npm_config_global_prefix: linkPrefix },
            }),
        ).resolves.toBe(0);
        expect(test.databasePath).not.toHaveBeenCalled();
        expect(test.report).not.toHaveBeenCalled();
    });

    it('is silent and does not create a database on a fresh global install', async () => {
        const test = fixture();
        await expect(runNpmPostinstall(test.packageRoot, test.runtime)).resolves.toBe(0);
        expect(test.retireReaders).not.toHaveBeenCalled();
        expect(test.report).not.toHaveBeenCalled();
    });

    it('does not retire readers of an already encrypted or unrecognized database', async () => {
        const test = fixture();
        const bytes = Buffer.from('encrypted database bytes');
        writeFileSync(test.database, bytes);
        await expect(runNpmPostinstall(test.packageRoot, test.runtime)).resolves.toBe(0);
        expect(readFileSync(test.database)).toEqual(bytes);
        expect(test.retireReaders).not.toHaveBeenCalled();
        expect(test.report).not.toHaveBeenCalled();
    });

    it('uses only filesystem inspection and the proven retirement seam without opening or modifying SQLite', async () => {
        const test = fixture();
        // It has the legacy header but is deliberately not an openable SQLite
        // database: any accidental SQLite construction would fail this proof.
        const bytes = Buffer.from('SQLite format 3\0inert fixture bytes');
        writeFileSync(test.database, bytes);
        test.retireReaders.mockResolvedValue(1);
        await expect(runNpmPostinstall(test.packageRoot, test.runtime)).resolves.toBe(1);
        expect(readFileSync(test.database)).toEqual(bytes);
        expect(test.retireReaders).toHaveBeenCalledExactlyOnceWith(test.database, {
            bin: path.join(test.prefix, 'bin', 'elepha'),
            packageRoot: test.packageRoot,
        });
        expect(test.report).toHaveBeenCalledExactlyOnceWith(npmPostinstallRetiredMessage(1));
        expect(npmPostinstallRetiredMessage(1)).toBe('Retired 1 stale elepha MCP process(es) during npm upgrade.');
    });

    it('does not warn or mutate when no eligible reader exists', async () => {
        const test = fixture();
        writeFileSync(test.database, 'SQLite format 3\0inert fixture bytes');
        await expect(runNpmPostinstall(test.packageRoot, test.runtime)).resolves.toBe(0);
        expect(test.retireReaders).toHaveBeenCalledOnce();
        expect(test.report).not.toHaveBeenCalled();
    });

    it('reports a relevant inspection failure without failing npm or altering plaintext data', async () => {
        const test = fixture();
        const bytes = Buffer.from('SQLite format 3\0inert fixture bytes');
        writeFileSync(test.database, bytes);
        test.retireReaders.mockRejectedValue(new Error('process inspection denied'));
        await expect(runNpmPostinstall(test.packageRoot, test.runtime)).resolves.toBe(0);
        expect(readFileSync(test.database)).toEqual(bytes);
        expect(test.report).toHaveBeenCalledExactlyOnceWith(npmPostinstallFailureMessage('process inspection denied'));
        expect(npmPostinstallFailureMessage('process inspection denied')).toBe(
            'elepha could not retire a legacy MCP during npm upgrade: process inspection denied. Run elepha install to retry.',
        );
    });
});

describe('shipped npm lifecycle entrypoint', () => {
    it('ships the fixed postinstall command and bin with lifecycle lock metadata', () => {
        const manifest = JSON.parse(readFileSync(path.resolve('package.json'), 'utf8'));
        const lock = JSON.parse(readFileSync(path.resolve('package-lock.json'), 'utf8'));
        expect(manifest.scripts.postinstall).toBe('node ./bin/postinstall.js');
        expect(manifest.files).toContain('bin');
        expect(lock.packages[''].hasInstallScript).toBe(true);
    });

    it('does not even import dist in local installs and keeps import failures nonfatal globally', () => {
        const test = fixture();
        const script = path.join(test.packageRoot, 'bin', 'postinstall.js');
        copyFileSync(path.resolve('bin/postinstall.js'), script);
        mkdirSync(path.join(test.packageRoot, 'dist', 'install'), { recursive: true });
        writeFileSync(
            path.join(test.packageRoot, 'dist', 'install', 'npm-postinstall.js'),
            "throw new Error('bootstrap fixture failure');\n",
        );
        const local = spawnSync(process.execPath, [script], {
            cwd: test.packageRoot,
            encoding: 'utf8',
            env: { ...process.env, ...test.env, npm_config_global: 'false' },
        });
        expect(local).toMatchObject({ status: 0, stdout: '', stderr: '' });
        const global = spawnSync(process.execPath, [script], {
            cwd: test.packageRoot,
            encoding: 'utf8',
            env: { ...process.env, ...test.env },
        });
        expect(global).toMatchObject({ status: 0, stdout: '', stderr: 'bootstrap fixture failure\n' });
    });
});
