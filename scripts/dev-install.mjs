import { spawn } from 'node:child_process';
import { accessSync, constants, existsSync, readFileSync, realpathSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tsImport } from 'tsx/esm/api';

const script = fileURLToPath(import.meta.url);
const checkout = path.dirname(path.dirname(script));

// Capture only when a later step needs stdout; tee it live so failures remain visible.
export function run(command, args, { capture = false, allowFailure = false, env = process.env, cwd = checkout } = {}) {
    console.log(`> ${[command, ...args].join(' ')}`);
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, { cwd, env, shell: false, stdio: ['inherit', capture ? 'pipe' : 'inherit', 'inherit'] });
        let stdout = '';
        child.stdout?.setEncoding('utf8');
        child.stdout?.on('data', (chunk) => {
            stdout += chunk;
            process.stdout.write(chunk);
        });
        child.on('error', (error) => {
            console.error(error.message);
            if (allowFailure) resolve({ status: 1, stdout });
            else reject(error);
        });
        child.on('close', (status, signal) => {
            if (status !== 0 && !allowFailure) reject(new Error(`${command} failed (${signal ?? status})`));
            else resolve({ status: status ?? 1, stdout });
        });
    });
}

function onPath(name) {
    return (process.env.PATH ?? '')
        .split(path.delimiter)
        .filter(Boolean)
        .map((dir) => path.join(dir, name))
        .find((file) => {
            try {
                accessSync(file, constants.X_OK);
                return true;
            } catch {
                return false;
            }
        });
}

export async function main() {
    const execPath = realpathSync(process.execPath);
    // npm run can retain a different Node on PATH. All npm children must use this runtime.
    process.env.PATH = `${path.dirname(execPath)}${path.delimiter}${process.env.PATH ?? ''}`;
    const { detectLauncherBackend } = await tsImport('../src/install/launcher.ts', import.meta.url);
    const manifest = JSON.parse(readFileSync(path.join(checkout, 'package.json'), 'utf8'));
    const options = {
        execPath,
        packageRoot: checkout,
        sourceBin: path.join(path.dirname(execPath), 'elepha'),
        minimumNodeVersion: manifest.engines.node.slice(2),
    };
    const nvmIndex = execPath.indexOf('/versions/node/');
    let backend;
    if (nvmIndex >= 0) {
        try {
            backend = detectLauncherBackend(options);
        } catch (error) {
            console.error(error.message);
            const root = execPath.slice(0, nvmIndex);
            const nvmExec = path.join(root, 'nvm-exec');
            if (process.env.ELEPHA_DEV_INSTALL_REEXEC || !existsSync(nvmExec) || !existsSync(path.join(root, 'nvm.sh'))) {
                throw new Error('Run: nvm use default && npm run dev:install');
            }
            console.log(`Detected nvm with active Node ${process.version}; restarting under its default.`);
            const result = await run(nvmExec, ['node', script], {
                allowFailure: true,
                env: { ...process.env, NVM_DIR: root, NODE_VERSION: 'default', ELEPHA_DEV_INSTALL_REEXEC: '1' },
            });
            if (result.status !== 0) throw new Error(`dev:install under nvm default failed (status ${result.status}); see output above.`);
            return;
        }
    }

    const prefix = (await run('npm', ['prefix', '-g'], { capture: true })).stdout.trim();
    const globalBin = path.join(prefix, 'bin', 'elepha');
    options.sourceBin = globalBin;
    const asdfIndex = execPath.indexOf('/installs/nodejs/');
    if (asdfIndex >= 0) {
        // The install detector also requires an elepha shim, which does not exist on a first dev install.
        const root = execPath.slice(0, asdfIndex);
        const active = path.basename(path.dirname(path.dirname(execPath)));
        const defaults = path.join(process.env.HOME, '.tool-versions');
        const selected = existsSync(defaults) ? /^nodejs\s+(\S+)/m.exec(readFileSync(defaults, 'utf8'))?.[1] : undefined;
        if (selected !== active) {
            const fix = selected
                ? `ASDF_NODEJS_VERSION=${selected} npm run dev:install`
                : 'asdf set -u nodejs <installed-24.x-version> && npm run dev:install';
            throw new Error(`Detected asdf default ${selected ?? 'missing'}, active ${active}. Run: ${fix}`);
        }
        const command = onPath('asdf') ?? ['/opt/homebrew/bin/asdf', '/usr/local/bin/asdf', path.join(root, 'asdf')].find(existsSync);
        if (!command) throw new Error('Run: add asdf to PATH, then npm run dev:install');
        backend = { kind: 'asdf', command, root };
    } else if (!backend) {
        try {
            backend = detectLauncherBackend(options);
        } catch (error) {
            if (execPath.includes('/node-versions/')) {
                throw new Error(`${error.message}\nRun: fnm default 24 && fnm use default && npm run dev:install`);
            }
            throw error;
        }
    }
    if (backend.kind === 'fnm') {
        const selected = await run(backend.command, ['exec', '--using=default', '--', 'node', '-p', 'process.execPath'], {
            capture: true,
            allowFailure: true,
            env: { ...process.env, FNM_DIR: backend.root },
        });
        if (selected.status !== 0) throw new Error('Run: fnm default 24 && fnm use default && npm run dev:install');
        const defaultNode = selected.stdout.trim().split('\n').at(-1);
        if (realpathSync(defaultNode) !== execPath) {
            throw new Error(`Detected fnm default ${defaultNode}, active ${execPath}. Run: fnm use default && npm run dev:install`);
        }
    }
    if (backend.kind === 'homebrew' && realpathSync(backend.node) !== execPath) {
        throw new Error(
            `Detected stale Homebrew Node ${execPath}. Run: export PATH="${path.dirname(backend.node)}:$PATH" && npm run dev:install`,
        );
    }
    console.log(`Detected ${backend.kind}, Node ${process.version}.`);
    await run('npm', ['run', 'build']);
    const packed = await run('npm', ['pack'], { capture: true });
    const filename = packed.stdout.trim().split('\n').at(-1);
    if (!filename || path.basename(filename) !== filename || !filename.endsWith('.tgz')) {
        throw new Error('npm pack did not print a tarball filename');
    }
    const tarball = path.join(checkout, filename);
    try {
        const existing = onPath('elepha');
        const { elephaLauncherPath } = await tsImport('../src/config/paths.ts', import.meta.url);
        const managedLauncher = elephaLauncherPath();
        const probe = existing ? await run(existing, ['--version'], { allowFailure: true }) : undefined;
        if (probe?.status === 0) {
            const removed = await run(existing, ['uninstall'], { allowFailure: true });
            if (removed.status !== 0) {
                console.warn('Installed uninstall failed; retrying cleanup through the fresh checkout.');
                await run(process.execPath, [path.join(checkout, 'bin', 'elepha.js'), 'uninstall']);
            }
        } else if (existing || existsSync(managedLauncher) || existsSync(globalBin)) {
            console.warn('Broken global installation detected; removing registrations through the fresh checkout.');
            await run(process.execPath, [path.join(checkout, 'bin', 'elepha.js'), 'uninstall']);
        }
        await run('npm', ['install', '-g', `./${filename}`]);
    } finally {
        unlinkSync(tarball);
    }
    if (backend.kind === 'asdf') await run(backend.command, ['reshim', 'nodejs']);
    // Prefer the package just installed even if PATH still contains an older launcher or global.
    await run(globalBin, ['install']);
    await run(globalBin, ['doctor'], { allowFailure: true });
}

if (process.argv[1] && path.resolve(process.argv[1]) === script) {
    main().catch((error) => {
        console.error(error.message);
        process.exitCode = 1;
    });
}
