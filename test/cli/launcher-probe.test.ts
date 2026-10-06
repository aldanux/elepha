import { type ExecException, execFile } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { MINIMUM_NODE_VERSION } from '../../src/config/constants.js';
import { renderLauncher } from '../../src/install/launcher.js';
import { withGrantableTestDir } from '../helpers/tmp.js';

// Every launcher rendered by elepha 0.4.0 through 0.8.x carries this minimum.
// Self-update never regenerates a launcher, so a newer package must keep
// accepting it.
const PREVIOUS_LAUNCHER_MINIMUM = '22.12.0';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const run = promisify(execFile);
const NPM_TIMEOUT_MS = 120_000;
const INTEGRATION_TIMEOUT_MS = 180_000;
const LAUNCHER_TIMEOUT_MS = 15_000;
const CHILD_OUTPUT_MAX_BYTES = 1024 * 1024;

async function runChild(bin: string, args: string[], env: NodeJS.ProcessEnv) {
    try {
        const result = await run(bin, args, {
            cwd: repositoryRoot,
            encoding: 'utf8',
            env,
            timeout: LAUNCHER_TIMEOUT_MS,
            maxBuffer: CHILD_OUTPUT_MAX_BYTES,
        });
        return { status: 0, stdout: result.stdout, stderr: result.stderr };
    } catch (error) {
        const failure = error as ExecException & { stdout: string; stderr: string };
        // Expected probe refusals are numeric exits. Timeout, signal and spawn
        // failures remain errors instead of masquerading as a rejected manifest.
        if (typeof failure.code !== 'number' || failure.killed || failure.signal) throw error;
        return { status: failure.code, stdout: failure.stdout, stderr: failure.stderr };
    }
}

function runProbe(bin: string, minimum: string, env: NodeJS.ProcessEnv) {
    return runChild(bin, ['internal', 'launcher-probe', String(minimum)], env);
}

// Records every module the package entry loads while answering the probe.
async function probeModuleLoads(entry: string, record: string, env: NodeJS.ProcessEnv) {
    const hook = `data:text/javascript,${encodeURIComponent(
        "import{registerHooks}from'node:module';import{writeFileSync}from'node:fs';const seen=[];registerHooks({load(url,context,next){seen.push(url);return next(url,context)}});process.on('exit',()=>writeFileSync(process.env.ELEPHA_TEST_MODULE_RECORD,JSON.stringify(seen)))",
    )}`;
    const result = await runChild(process.execPath, ['--import', hook, entry, 'internal', 'launcher-probe', MINIMUM_NODE_VERSION], {
        ...env,
        ELEPHA_TEST_MODULE_RECORD: record,
    });
    return { status: result.status, modules: JSON.parse(readFileSync(record, 'utf8')) as string[] };
}

function runVersion(bin: string, env: NodeJS.ProcessEnv) {
    return runChild(bin, ['--version'], env);
}

describe('launcher probe', () => {
    it(
        'runs from a real packed global installation and rejects invalid installed manifests',
        async () => {
            const root = withGrantableTestDir('elepha-launcher-probe-');
            const packDirectory = path.join(root, 'pack');
            const prefix = path.join(root, 'prefix');
            const cache = path.join(root, 'npm-cache');
            const temporary = path.join(root, 'temporary');
            const elephaState = path.join(root, 'elepha-state');
            const npmConfig = path.join(root, 'npm-config');
            const npmGlobalConfig = path.join(root, 'npm-global-config');
            for (const directory of [packDirectory, temporary, elephaState]) mkdirSync(directory);
            writeFileSync(npmConfig, '');
            writeFileSync(npmGlobalConfig, '');
            const env = { ...process.env };
            for (const key of Object.keys(env)) {
                if (/^(npm_|ELEPHA_)/i.test(key)) delete env[key];
            }
            env.ELEPHA_HOME = elephaState;
            env.TMPDIR = temporary;
            env.PATH = `${path.dirname(process.execPath)}${path.delimiter}${env.PATH ?? ''}`;
            const npmBin = realpathSync(path.join(path.dirname(process.execPath), 'npm'));
            const npmOptions = ['--cache', cache, '--userconfig', npmConfig, '--globalconfig', npmGlobalConfig];
            const npm = async (args: string[]) =>
                (
                    await run(process.execPath, [npmBin, ...args, ...npmOptions], {
                        cwd: repositoryRoot,
                        env,
                        encoding: 'utf8',
                        timeout: NPM_TIMEOUT_MS,
                        maxBuffer: CHILD_OUTPUT_MAX_BYTES,
                    })
                ).stdout;
            const [{ filename }] = JSON.parse(
                await npm(['pack', '--json', '--ignore-scripts', '--pack-destination', packDirectory]),
            ) as Array<{ filename: string }>;
            await npm([
                'install',
                '--global',
                '--prefix',
                prefix,
                '--ignore-scripts',
                '--no-audit',
                '--no-fund',
                path.join(packDirectory, filename),
            ]);

            const bin = path.join(prefix, 'bin', 'elepha');
            const packageJson = path.join(prefix, 'lib', 'node_modules', 'elepha', 'package.json');
            const original = JSON.parse(readFileSync(packageJson, 'utf8')) as { name: string; version: string; engines: { node: string } };

            expect((await runProbe(bin, MINIMUM_NODE_VERSION, env)).status).toBe(0);
            expect(await runProbe(bin, PREVIOUS_LAUNCHER_MINIMUM, env)).toMatchObject({ status: 0, stdout: '', stderr: '' });
            // A launcher minimum at or below the package floor is compatible;
            // the runtime is still checked against the package floor below.
            expect((await runProbe(bin, '22.0.0', env)).status).toBe(0);
            const legacyLauncher = await runProbe(bin, MINIMUM_NODE_VERSION.split('.')[0]!, env);
            expect(legacyLauncher).toMatchObject({ status: 0, stdout: '', stderr: '' });
            expect((await runProbe(bin, '21', env)).stderr).toContain('launcher probe failed: engines.node');
            for (const newer of ['22.15.1', '99.0.0']) {
                const higher = await runProbe(bin, newer, env);
                expect(higher.status).toBe(66);
                expect(higher.stderr).toContain('launcher probe failed: engines.node');
            }
            for (const malformed of ['22.12', 'v22.12.0', '0', 'latest']) {
                const rejected = await runProbe(bin, malformed, env);
                expect(rejected.status).toBe(66);
                expect(rejected.stderr).toContain('launcher probe failed: minimum version');
            }
            expect(await runVersion(bin, env)).toMatchObject({ status: 0, stdout: `${original.version}\n` });

            // A launcher rendered by the previous release, never regenerated,
            // still dispatches to the new package, including under the service
            // manager where a failed probe would exit 0 without running it.
            const previousLauncher = path.join(root, 'previous-launcher');
            writeFileSync(
                previousLauncher,
                renderLauncher(
                    { kind: 'standalone', command: bin, node: process.execPath, npmBin: path.dirname(process.execPath) },
                    PREVIOUS_LAUNCHER_MINIMUM,
                ),
            );
            chmodSync(previousLauncher, 0o755);
            for (const service of ['', '1']) {
                expect(await runChild(previousLauncher, ['--version'], { ...env, ELEPHA_SERVICE: service })).toMatchObject({
                    status: 0,
                    stdout: `${original.version}\n`,
                });
            }

            // The managed service launcher runs this probe ahead of every daemon
            // start, under launchd's throttled background QoS. It must answer
            // from the probe module alone, never by loading the whole CLI with
            // its storage modules and native addons ahead of the first heartbeat.
            const loaded = await probeModuleLoads(
                path.join(prefix, 'lib', 'node_modules', 'elepha', 'bin', 'elepha.js'),
                path.join(root, 'probe-modules.json'),
                env,
            );
            expect(loaded.status).toBe(0);
            expect(loaded.modules.some((url) => url.endsWith('/dist/cli/launcher-probe.js'))).toBe(true);
            const packageModules = loaded.modules.filter((url) => url.includes('/node_modules/elepha/') && !url.endsWith('/bin/elepha.js'));
            expect(packageModules).toEqual(
                packageModules.filter((url) => url.endsWith('/dist/cli/launcher-probe.js') || url.endsWith('/dist/util/error.js')),
            );

            writeFileSync(packageJson, JSON.stringify({ ...original, name: 'not-elepha' }));
            const wrongName = await runProbe(bin, MINIMUM_NODE_VERSION, env);
            expect(wrongName.status).toBe(66);
            expect(wrongName.stderr).toContain('launcher probe failed: package name');
            expect(wrongName.stderr).toContain('package name: expected "elepha", observed "not-elepha"');
            expect(wrongName.stderr).toContain(
                `engines.node: expected canonical >=N.N.N at or above ${MINIMUM_NODE_VERSION}, observed ">=${MINIMUM_NODE_VERSION}"`,
            );
            expect(wrongName.stderr).toContain(`node version: expected >=${MINIMUM_NODE_VERSION}, observed ${process.versions.node}`);
            expect(wrongName.stderr).toContain('process.execPath: expected not constrained, observed ');
            expect(wrongName.stderr).toContain('bin.elepha: expected not constrained, observed "./bin/elepha.js"');
            expect(wrongName.stderr).toContain('resolved package root: expected readable package root, observed ');

            writeFileSync(packageJson, JSON.stringify({ ...original, engines: { node: '^22' } }));
            const badEngine = await runProbe(bin, MINIMUM_NODE_VERSION, env);
            expect(badEngine.status).toBe(66);
            expect(badEngine.stderr).toContain('launcher probe failed: engines.node');

            writeFileSync(packageJson, JSON.stringify({ ...original, engines: { node: '>=99.0.0' } }));
            const oldNode = await runProbe(bin, '99.0.0', env);
            expect(oldNode.status).toBe(66);
            expect(oldNode.stderr).toContain('launcher probe failed: node version');
            // An older launcher minimum never lowers the installed package's floor.
            const olderLauncher = await runProbe(bin, PREVIOUS_LAUNCHER_MINIMUM, env);
            expect(olderLauncher.status).toBe(66);
            expect(olderLauncher.stderr).toContain('launcher probe failed: node version');
            expect(olderLauncher.stderr).toContain('expected: >=99.0.0');
            expect(await runChild(previousLauncher, ['--version'], { ...env, ELEPHA_SERVICE: '' })).toMatchObject({
                status: 66,
                stdout: '',
                stderr: 'elepha launcher failed: package-invalid\n',
            });
        },
        INTEGRATION_TIMEOUT_MS,
    );
});
