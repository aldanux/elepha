import { mkdirSync } from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import path from 'node:path';

const workerId = process.env.VITEST_WORKER_ID ?? String(process.pid);
const workerElephaHome = path.join(process.cwd(), '.test-scratch', `elepha-home-${workerId}`);
const lifecycleTestDirectory = path.join(process.cwd(), '.test-scratch', `database-lifecycle-${process.pid}-${workerId}`);
const lifecycleTestDirectorySymbol = 'dev.elepha.internal.database-lifecycle-test-directory';
const childProcessPatchSymbol = Symbol.for('dev.elepha.internal.database-lifecycle-test-child-patch');

mkdirSync(workerElephaHome, { recursive: true });
process.env.ELEPHA_HOME = workerElephaHome;

// Keep the user-global production rendezvous hermetic without changing HOME or
// adding a product configuration surface. Node child tests receive the same
// process-local injection before their first application module is imported.
(globalThis as Record<symbol, unknown>)[Symbol.for(lifecycleTestDirectorySymbol)] = lifecycleTestDirectory;
const preloadSource = `globalThis[Symbol.for(${JSON.stringify(lifecycleTestDirectorySymbol)})] = ${JSON.stringify(lifecycleTestDirectory)};`;
const lifecyclePreload = `data:text/javascript,${encodeURIComponent(preloadSource)}`;
const mutableChildProcess = createRequire(import.meta.url)('node:child_process') as {
    spawn: typeof import('node:child_process').spawn;
    spawnSync: typeof import('node:child_process').spawnSync;
} & Record<symbol, unknown>;

function injectLifecyclePreload(command: string, callArguments: unknown[]): unknown[] {
    if (command !== process.execPath || !Array.isArray(callArguments[0])) {
        return callArguments;
    }
    const options = callArguments[1];
    const childOptions = options !== null && typeof options === 'object' ? options : {};
    const inheritedEnvironment =
        'env' in childOptions && childOptions.env !== undefined ? (childOptions.env as NodeJS.ProcessEnv) : process.env;
    const nodeOptions = [inheritedEnvironment.NODE_OPTIONS, `--import=${lifecyclePreload}`].filter(Boolean).join(' ');
    return [
        ['--import', lifecyclePreload, ...callArguments[0]],
        { ...childOptions, env: { ...inheritedEnvironment, NODE_OPTIONS: nodeOptions } },
        ...callArguments.slice(2),
    ];
}

if (mutableChildProcess[childProcessPatchSymbol] !== true) {
    const originalSpawn = mutableChildProcess.spawn;
    const originalSpawnSync = mutableChildProcess.spawnSync;
    mutableChildProcess.spawn = ((command: string, ...callArguments: unknown[]) =>
        Reflect.apply(originalSpawn, mutableChildProcess, [
            command,
            ...injectLifecyclePreload(command, callArguments),
        ])) as typeof originalSpawn;
    mutableChildProcess.spawnSync = ((command: string, ...callArguments: unknown[]) =>
        Reflect.apply(originalSpawnSync, mutableChildProcess, [
            command,
            ...injectLifecyclePreload(command, callArguments),
        ])) as typeof originalSpawnSync;
    mutableChildProcess[childProcessPatchSymbol] = true;
    syncBuiltinESMExports();
}
