import { execFile } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { resolveInstalledElephaBin } from '../../src/install/binary.js';
import { withGrantableTestDir } from '../helpers/tmp.js';

const run = promisify(execFile);

describe('packed global npm postinstall boundary', () => {
    it('runs the shipped hook with npm-provided global lifecycle coordinates and preserves the installed package', async () => {
        const repository = process.cwd();
        const root = withGrantableTestDir('npm-packed-postinstall-');
        const prefix = path.join(root, 'global prefix with spaces');
        const elephaState = path.join(root, 'elepha-state');
        const cache = path.join(root, 'npm-cache');
        const temporary = path.join(root, 'temporary');
        const archives = path.join(root, 'archives');
        for (const directory of [elephaState, temporary, archives]) mkdirSync(directory);
        const npmConfig = path.join(root, 'npm-config');
        const npmGlobalConfig = path.join(root, 'npm-global-config');
        writeFileSync(npmConfig, '');
        writeFileSync(npmGlobalConfig, '');
        const databasePath = path.join(elephaState, 'elepha.db');
        const databaseBytes = Buffer.from('SQLite format 3\0inert lifecycle fixture');
        writeFileSync(databasePath, databaseBytes);

        const observation = path.join(root, 'lifecycle.json');
        const observer = path.join(root, 'observe-lifecycle.mjs');
        // Observe npm's real child environment without wrapping or modifying
        // the packed postinstall. Never record inherited credentials or HOME.
        writeFileSync(
            observer,
            `import { writeFileSync } from 'node:fs';
if (process.env.npm_package_name === 'elepha' && process.env.npm_lifecycle_event === 'postinstall') {
    writeFileSync(${JSON.stringify(observation)}, JSON.stringify({
        argv: process.argv.slice(1), cwd: process.cwd(),
        global: process.env.npm_config_global,
        prefix: process.env.npm_config_global_prefix,
        manifest: process.env.npm_package_json,
        lifecycle: process.env.npm_lifecycle_event,
        script: process.env.npm_lifecycle_script,
        elephaState: process.env.ELEPHA_HOME,
    }));
}
`,
        );
        const env = { ...process.env };
        // Let npm supply every lifecycle coordinate itself. Keep memory,
        // configuration, cache, and temporary writes inside this fixture.
        for (const key of Object.keys(env)) {
            if (/^(npm_|ELEPHA_)/i.test(key)) delete env[key];
        }
        env.ELEPHA_HOME = elephaState;
        env.TMPDIR = temporary;
        env.NODE_OPTIONS = `--import=${pathToFileURL(observer).href}`;
        env.PATH = `${path.dirname(process.execPath)}${path.delimiter}${env.PATH ?? ''}`;
        const npm = realpathSync(path.join(path.dirname(process.execPath), 'npm'));
        const npmOptions = ['--cache', cache, '--userconfig', npmConfig, '--globalconfig', npmGlobalConfig];
        const options = { cwd: repository, env, timeout: 120_000, maxBuffer: 1024 * 1024 };
        const packed = await run(
            process.execPath,
            [npm, 'pack', '--json', '--ignore-scripts', '--pack-destination', archives, ...npmOptions],
            options,
        );
        const [archive] = JSON.parse(packed.stdout) as Array<{ filename: string }>;
        expect(archive).toBeDefined();
        if (archive === undefined) throw new Error('npm pack did not produce an archive.');
        const installed = await run(
            process.execPath,
            [
                npm,
                'install',
                '--global',
                '--prefix',
                prefix,
                '--foreground-scripts',
                '--ignore-scripts=false',
                '--no-audit',
                '--no-fund',
                path.join(archives, archive.filename),
                ...npmOptions,
            ],
            options,
        );
        const manifest = JSON.parse(readFileSync(path.join(repository, 'package.json'), 'utf8'));
        const packageRoot = path.join(prefix, 'lib', 'node_modules', 'elepha');
        expect(installed.stdout).toContain(`> elepha@${manifest.version} postinstall\n> node ./bin/postinstall.js\n`);
        expect(JSON.parse(readFileSync(observation, 'utf8'))).toEqual({
            argv: [path.join(packageRoot, 'bin', 'postinstall.js')],
            cwd: packageRoot,
            global: 'true',
            prefix,
            manifest: path.join(packageRoot, 'package.json'),
            lifecycle: 'postinstall',
            script: 'node ./bin/postinstall.js',
            elephaState,
        });
        expect(installed.stderr).not.toContain('elepha could not retire');
        expect(readFileSync(databasePath)).toEqual(databaseBytes);
        expect(readdirSync(elephaState)).toEqual(['elepha.db']);
        expect(JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8'))).toEqual(manifest);
        const resolved = resolveInstalledElephaBin({ pathValue: path.join(prefix, 'bin') });
        expect(resolved).toEqual({ bin: path.join(prefix, 'bin', 'elepha'), packageRoot });
        const version = await run(process.execPath, [resolved.bin, '--version'], options);
        expect(version.stdout).toBe(`${manifest.version}\n`);
        expect(version.stderr).toBe('');
    }, 180_000);
});
