import { type ChildProcess, execFile } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, copyFileSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { migrateDatabaseForInstall, retiredLegacyMcpMessage } from '../../src/install/database-migration.js';
import { macosLegacyMcpProbe, retiredNpmPackageRoot, retireLegacyMcpReaders } from '../../src/install/legacy-mcp.js';
import { npmPostinstallRetiredMessage, runNpmPostinstall } from '../../src/install/npm-postinstall.js';
import { macosDatabaseOpenFiles, macosProcessOpenFiles } from '../../src/security/subprocess-allowlist.js';
import {
    DATABASE_MIGRATION_CONNECTIONS_ACTIVE,
    type DatabaseMigrationRuntime,
    migratePrimaryDatabaseToEncrypted,
} from '../../src/storage/database-migration.js';
import { openManagedDatabase, openUnmanagedDb } from '../../src/storage/db.js';
import { withGrantableTestDir } from '../helpers/tmp.js';

async function waitForReader(child: ChildProcess): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Legacy MCP fixture did not open its database.')), 5000);
        child.stdout?.once('data', (chunk) => {
            clearTimeout(timer);
            if (String(chunk) === 'ready\n') resolve();
            else reject(new Error(`Unexpected legacy fixture output: ${String(chunk)}`));
        });
        child.once('error', (error) => {
            clearTimeout(timer);
            reject(error);
        });
        child.once('exit', (code, signal) => {
            clearTimeout(timer);
            reject(new Error(`Legacy fixture exited: ${code}/${signal}`));
        });
    });
}

describe('post-npm-replacement legacy MCP migration regression', () => {
    it.each(['install retry', 'old updater bootstrap'] as const)(
        'retires only the real stale RO child and preserves all rows via %s',
        async (mode) => {
            const root = withGrantableTestDir('legacy-mcp-npm-upgrade-');
            const databasePath = path.join(root, 'elepha.db');
            const prefix = path.join(root, 'npm with spaces');
            const packageRoot = path.join(prefix, 'lib', 'node_modules', 'elepha');
            const script = path.join(packageRoot, 'bin', 'elepha.js');
            const nativeRelativePath = path.join('node_modules', 'better-sqlite3', 'prebuilds', `${process.platform}-${process.arch}.node`);
            // Materialize npm's final retired state directly: the managed runner
            // refuses renaming a loaded node_modules package. This fixture proves
            // retirement from that state, not npm's rename operation itself.
            const nativePath = path.join(retiredNpmPackageRoot(packageRoot), nativeRelativePath);
            mkdirSync(path.dirname(script), { recursive: true });
            mkdirSync(path.dirname(nativePath), { recursive: true });
            copyFileSync(
                path.resolve('node_modules/better-sqlite3-multiple-ciphers/prebuilds', `${process.platform}-${process.arch}.node`),
                nativePath,
            );
            writeFileSync(
                path.join(packageRoot, 'package.json'),
                JSON.stringify({ name: 'elepha', type: 'module', bin: { elepha: './bin/elepha.js' } }),
            );
            const database = openUnmanagedDb(databasePath);
            database.exec("INSERT INTO projects (id, path, first_seen_at, last_seen_at) VALUES (1, '/project', 'now', 'now')");
            database.exec(
                "INSERT INTO sessions (id, tool, native_id, project_id, source_path, started_at, last_ingested_at) VALUES (1, 'codex', 'preserved-legacy-session', 1, '/inert-transcript', 'now', 'now')",
            );
            database.close();
            const driver = pathToFileURL(path.resolve('node_modules/better-sqlite3-multiple-ciphers/lib/index.js')).href;
            // Reproduce the old installed entrypoint: one unmanaged, lifelong
            // read-only WAL connection and the same script argv and native mapping.
            writeFileSync(
                script,
                `import Database from ${JSON.stringify(driver)};
const db = new Database(${JSON.stringify(databasePath)}, { readonly: true, fileMustExist: true, nativeBinding: ${JSON.stringify(nativePath)} });
db.exec('BEGIN');
db.prepare('SELECT native_id FROM sessions').get();
process.stdin.resume();
process.stdin.on('data', () => db.prepare('SELECT native_id FROM sessions').get());
process.stdout.write('ready\\n');
`,
            );
            chmodSync(script, 0o755);
            const child = execFile(process.execPath, [script, 'mcp', 'serve'], { env: { ...process.env, ELEPHA_HOME: root } });
            let stderr = '';
            child.stderr?.on('data', (chunk) => {
                stderr += String(chunk);
            });
            try {
                await waitForReader(child);
                const pid = child.pid;
                if (pid === undefined) throw new Error('Legacy fixture has no PID.');
                // A later install runs after npm removed its retired tree;
                // postinstall runs before that cleanup. Exercise both states.
                if (mode === 'install retry') unlinkSync(nativePath);
                writeFileSync(
                    path.join(packageRoot, 'package.json'),
                    JSON.stringify({ name: 'elepha', type: 'module', bin: { elepha: './bin/elepha.js' } }),
                );
                writeFileSync(script, '// replacement package entrypoint\n');
                const installed = { bin: script, packageRoot };
                const migrationRuntime: DatabaseMigrationRuntime = {
                    platform: 'linux',
                    arch: 'x64',
                    libc: 'glibc',
                    env: { CI: '1' },
                    keyFilePath: () => path.join(root, 'migration.keydata'),
                    statePaths: { lock: path.join(root, 'migration.lock'), manifest: path.join(root, 'migration.json') },
                    availableBytes: () => BigInt(Number.MAX_SAFE_INTEGER),
                };
                const messages: string[] = [];
                let attempts = 0;
                let migrationBlocked = false;
                // This runner denies ps. Supply only the exact argv and lifetime
                // of our own ChildProcess; lsof still proves the real PID, UID,
                // RO descriptor, inode, and npm-renamed native mapping on macOS.
                // Linux exercises the complete production /proc inspection.
                const probe =
                    process.platform === 'darwin'
                        ? macosLegacyMcpProbe(databasePath, statSync(databasePath, { bigint: true }), {
                              databaseFiles: macosDatabaseOpenFiles,
                              processFiles: macosProcessOpenFiles,
                              processCommand: (requestedPid) => {
                                  expect(requestedPid).toBe(pid);
                                  return child.exitCode === null && child.signalCode === null
                                      ? `${pid} ${process.getuid?.()} Mon Sep  7 12:00:00 2026 ${process.execPath} ${script} mcp serve\n`
                                      : '';
                              },
                          })
                        : undefined;
                const retireReaders = async (file: string, resolved: typeof installed) => {
                    expect(migrationBlocked).toBe(true);
                    return retireLegacyMcpReaders(file, resolved, probe === undefined ? {} : { probe });
                };
                if (mode === 'old updater bootstrap') {
                    await expect(migratePrimaryDatabaseToEncrypted(databasePath, migrationRuntime)).rejects.toThrow(
                        DATABASE_MIGRATION_CONNECTIONS_ACTIVE,
                    );
                    migrationBlocked = true;
                    const bytesBeforePostinstall = readFileSync(databasePath);
                    const identityBeforePostinstall = statSync(databasePath, { bigint: true });
                    await expect(
                        runNpmPostinstall(packageRoot, {
                            env: {
                                npm_config_global: 'true',
                                npm_lifecycle_event: 'postinstall',
                                npm_package_name: 'elepha',
                                npm_config_global_prefix: prefix,
                                npm_package_json: path.join(packageRoot, 'package.json'),
                            },
                            cwd: packageRoot,
                            databasePath: () => databasePath,
                            retireReaders,
                            report: (message) => messages.push(message),
                        }),
                    ).resolves.toBe(1);
                    expect(readFileSync(databasePath)).toEqual(bytesBeforePostinstall);
                    expect(readFileSync(databasePath).subarray(0, 16).toString('binary')).toBe('SQLite format 3\0');
                    expect(statSync(databasePath, { bigint: true })).toMatchObject({
                        dev: identityBeforePostinstall.dev,
                        ino: identityBeforePostinstall.ino,
                    });
                    // The already-running old updater invokes the original storage
                    // migration directly after npm returns, without the new wrapper.
                    attempts++;
                    await expect(migratePrimaryDatabaseToEncrypted(databasePath, migrationRuntime)).resolves.toEqual({
                        status: 'migrated',
                    });
                } else {
                    await migrateDatabaseForInstall(databasePath, {
                        migrate: async (file) => {
                            attempts++;
                            if (attempts === 1) {
                                try {
                                    await migratePrimaryDatabaseToEncrypted(file, migrationRuntime);
                                } catch (error) {
                                    expect(error).toHaveProperty('message', DATABASE_MIGRATION_CONNECTIONS_ACTIVE);
                                    migrationBlocked = true;
                                    throw error;
                                }
                                throw new Error('The legacy reader did not block the first migration attempt.');
                            }
                            await migratePrimaryDatabaseToEncrypted(file, migrationRuntime);
                        },
                        resolveInstalledBin: () => installed,
                        retireReaders,
                        report: (message) => messages.push(message),
                    });
                }
                expect(attempts).toBe(mode === 'old updater bootstrap' ? 1 : 2);
                if (child.exitCode === null && child.signalCode === null) await once(child, 'exit');
                expect(child.signalCode).toBe('SIGTERM');
                expect(messages).toEqual([mode === 'old updater bootstrap' ? npmPostinstallRetiredMessage(1) : retiredLegacyMcpMessage(1)]);
                expect(readFileSync(databasePath).subarray(0, 16).toString('binary')).not.toBe('SQLite format 3\0');
                const migrated = await openManagedDatabase(databasePath, {
                    readonly: true,
                    fileMustExist: true,
                    encryption: migrationRuntime,
                });
                try {
                    expect(migrated.prepare('SELECT native_id FROM sessions').all()).toEqual([{ native_id: 'preserved-legacy-session' }]);
                    expect(migrated.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }]);
                } finally {
                    migrated.close();
                }
            } catch (error) {
                throw new Error(`Legacy npm upgrade regression failed; child stderr: ${stderr}`, { cause: error });
            } finally {
                if (child.exitCode === null && child.signalCode === null && child.kill('SIGTERM')) {
                    await once(child, 'exit');
                }
            }
        },
        30_000,
    );
});
