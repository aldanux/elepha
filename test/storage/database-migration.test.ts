import { type ChildProcess, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { copyFileSync, existsSync, linkSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3-multiple-ciphers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DATABASE_KEYRING_TIMEOUT_MS } from '../../src/config/constants.js';
import { elephaPaths } from '../../src/config/paths.js';
import { encryptionKeyPath, encryptionMetadataPath, type KeyringEntry } from '../../src/storage/database-encryption.js';
import {
    acquireExclusiveDatabaseLifecycle,
    DATABASE_LIFECYCLE_AMBIGUOUS,
    DATABASE_LIFECYCLE_BUSY,
    databaseLifecyclePaths,
} from '../../src/storage/database-lifecycle.js';
import {
    DATABASE_KEY_COMMITMENT_INDETERMINATE,
    type DatabaseMigrationRuntime,
    migratePrimaryDatabaseToEncrypted,
} from '../../src/storage/database-migration.js';
import { openDb, openKeyedDatabase, openManagedDatabase, openUnmanagedDb } from '../../src/storage/db.js';
import { withGrantableTestDir } from '../helpers/tmp.js';

const FIXED_KEY = Buffer.from(Array.from({ length: 32 }, (_, index) => index + 1));
const MIGRATION_ID = '11111111-1111-4111-8111-111111111111';
const INSTALLATION_ID = '22222222-2222-4222-8222-222222222222';
const savedEnvironment = { ...process.env };
const repositoryRoot = path.resolve(import.meta.dirname, '..', '..');
const migrationModule = pathToFileURL(path.join(repositoryRoot, 'src', 'storage', 'database-migration.ts')).href;

async function killChild(child: ChildProcess): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) {
        return;
    }
    child.kill('SIGKILL');
    await once(child, 'exit');
}

function fixture(prefix: string): { directory: string; dbPath: string } {
    const directory = withGrantableTestDir(prefix);
    const dbPath = path.join(directory, 'elepha.db');
    const db = openUnmanagedDb(dbPath);
    db.exec(`
        INSERT INTO projects (id, path, first_seen_at, last_seen_at) VALUES (1, '/project', 'now', 'now');
        INSERT INTO sessions (id, tool, native_id, project_id, source_path, started_at, last_ingested_at)
        VALUES (1, 'codex', 'migration-session', 1, '/transcript', 'now', 'now');
        INSERT INTO memories
            (id, project_id, session_id, turn_index, tool, turn_started_at, decisions, files_touched, pending_items, created_at)
        VALUES (1, 1, 1, 0, 'codex', 'now', '["decision"]', '[]', '[]', 'now');
        INSERT INTO filtered_turns (memory_id, included, user_prompt, assistant_response, filter_version, captured_at)
        VALUES (1, 1, 'migration elephant', 'answer', 1, 'now');
    `);
    db.close();
    return { directory, dbPath };
}

function runtime(directory: string, overrides: Partial<DatabaseMigrationRuntime> = {}): DatabaseMigrationRuntime {
    return {
        platform: 'linux',
        arch: 'x64',
        libc: 'glibc',
        env: { CI: '1' },
        randomBytes: () => Buffer.from(FIXED_KEY),
        randomUUID: (() => {
            let calls = 0;
            return () => (calls++ === 0 ? MIGRATION_ID : INSTALLATION_ID);
        })(),
        keyFilePath: (dbPath) => path.join(path.dirname(dbPath), 'migration.keydata'),
        statePaths: {
            lock: path.join(directory, 'database-migration.lock'),
            manifest: path.join(directory, 'database-migration.json'),
        },
        availableBytes: () => BigInt(Number.MAX_SAFE_INTEGER),
        ...overrides,
    };
}

function isPlaintext(dbPath: string): boolean {
    return readFileSync(dbPath).subarray(0, 16).toString('binary') === 'SQLite format 3\0';
}

function assertPlaintextOpenable(dbPath: string): void {
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    expect(db.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }]);
    expect(db.prepare('SELECT native_id FROM sessions').get()).toEqual({ native_id: 'migration-session' });
    db.close();
}

async function waitForLifecycleIntent(dbPath: string): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (!hasLifecycleIntent(dbPath)) {
        if (Date.now() >= deadline) {
            throw new Error('Timed out waiting for database migration lifecycle intent.');
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
}

function hasLifecycleIntent(dbPath: string): boolean {
    const directory = databaseLifecyclePaths(dbPath).exclusive;
    return existsSync(directory) && readdirSync(directory).length > 0;
}

async function assertEncryptedOpenable(dbPath: string, migrationRuntime: DatabaseMigrationRuntime): Promise<void> {
    expect(isPlaintext(dbPath)).toBe(false);
    const writable = await openDb(dbPath, { encryption: migrationRuntime });
    expect(writable.prepare('SELECT native_id FROM sessions').get()).toEqual({ native_id: 'migration-session' });
    expect(writable.prepare("SELECT COUNT(*) AS count FROM filtered_turns_fts WHERE filtered_turns_fts MATCH 'elephant'").get()).toEqual({
        count: 1,
    });
    writable.close();
    const readonly = await openManagedDatabase(dbPath, { readonly: true, fileMustExist: true, encryption: migrationRuntime });
    expect(readonly.prepare('SELECT COUNT(*) AS count FROM memories').get()).toEqual({ count: 1 });
    readonly.close();
}

afterEach(() => {
    process.env = { ...savedEnvironment };
});

describe('plaintext primary database encryption migration', () => {
    it('atomically encrypts the primary with identical schema and rows, then becomes a no-op', async () => {
        const { directory, dbPath } = fixture('elepha-database-migration-');
        const migrationRuntime = runtime(directory);
        const before = new Database(dbPath, { readonly: true });
        const schema = before.prepare('SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name').all();
        const counts = (
            before.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>
        ).map(({ name }) => ({ name, count: before.prepare(`SELECT COUNT(*) AS count FROM "${name.replaceAll('"', '""')}"`).get() }));
        before.close();

        await expect(migratePrimaryDatabaseToEncrypted(dbPath, migrationRuntime)).resolves.toEqual({ status: 'migrated' });
        await assertEncryptedOpenable(dbPath, migrationRuntime);
        expect(statSync(dbPath).mode & 0o777).toBe(0o600);
        expect(existsSync(migrationRuntime.statePaths?.manifest ?? '')).toBe(false);
        expect(existsSync(migrationRuntime.statePaths?.lock ?? '')).toBe(false);
        const reopened = await openManagedDatabase(dbPath, { readonly: true, fileMustExist: true, encryption: migrationRuntime });
        expect(reopened.prepare('SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name').all()).toEqual(schema);
        expect(
            (reopened.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>).map(
                ({ name }) => ({ name, count: reopened.prepare(`SELECT COUNT(*) AS count FROM "${name.replaceAll('"', '""')}"`).get() }),
            ),
        ).toEqual(counts);
        reopened.close();

        await expect(
            migratePrimaryDatabaseToEncrypted(dbPath, {
                ...runtime(directory),
                randomBytes: () => {
                    throw new Error('already encrypted must not generate a key');
                },
            }),
        ).resolves.toEqual({ status: 'already-encrypted' });
    });

    it('encrypts every retained managed backup under the installation key without changing its content', async () => {
        const { directory, dbPath } = fixture('elepha-database-migration-backups-');
        const expectedBackups = [
            { name: 'elepha.db.bak-2026-09-01', nativeId: 'backup-older' },
            { name: 'elepha.db.bak-2026-09-02', nativeId: 'backup-newer' },
        ];
        for (const expected of expectedBackups) {
            const backupPath = path.join(directory, expected.name);
            copyFileSync(dbPath, backupPath);
            const backup = new Database(backupPath);
            backup.prepare('UPDATE sessions SET native_id = ?').run(expected.nativeId);
            backup.close();
        }

        await expect(migratePrimaryDatabaseToEncrypted(dbPath, runtime(directory))).resolves.toEqual({ status: 'migrated' });

        const retainedBackups = readdirSync(directory)
            .filter((entry) => entry.startsWith(`${path.basename(dbPath)}.bak-`))
            .sort()
            .map((entry) => path.join(directory, entry));
        expect(retainedBackups.map((backupPath) => path.basename(backupPath))).toEqual(expectedBackups.map(({ name }) => name));
        expect(retainedBackups.map((backupPath) => isPlaintext(backupPath))).toEqual(expectedBackups.map(() => false));
        for (const [index, backupPath] of retainedBackups.entries()) {
            const backup = openKeyedDatabase(backupPath, FIXED_KEY, { readonly: true, fileMustExist: true });
            try {
                expect(backup.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }]);
                expect(backup.prepare('SELECT native_id FROM sessions').get()).toEqual({
                    native_id: expectedBackups[index]?.nativeId,
                });
            } finally {
                backup.close();
            }
        }
    });

    it('opens retained plaintext backups read-only throughout migration', async () => {
        const { directory, dbPath } = fixture('elepha-database-migration-readonly-backup-');
        const backupPath = `${dbPath}.bak-2026-09-01`;
        copyFileSync(dbPath, backupPath);
        const backup = new Database(backupPath);
        backup.prepare('UPDATE sessions SET native_id = ?').run('readonly-backup');
        backup.close();

        const originalClose = Database.prototype.close;
        const observedModes: boolean[] = [];
        Database.prototype.close = function recordManagedBackupMode() {
            try {
                const session = this.prepare('SELECT native_id FROM sessions').get() as { native_id?: unknown } | undefined;
                if (session?.native_id === 'readonly-backup' && path.basename(this.name) === path.basename(backupPath)) {
                    observedModes.push(this.readonly);
                }
            } catch {
                // Encrypted verification handles cannot be queried without their key.
            }
            return originalClose.call(this);
        };

        try {
            await expect(migratePrimaryDatabaseToEncrypted(dbPath, runtime(directory))).resolves.toEqual({ status: 'migrated' });
        } finally {
            Database.prototype.close = originalClose;
        }

        expect(observedModes.length).toBeGreaterThan(0);
        expect(observedModes).toEqual(observedModes.map(() => true));
    });

    it('encrypts a valid legacy backup whose child table predates its parent', async () => {
        const { directory, dbPath } = fixture('elepha-database-migration-legacy-foreign-key-order-');
        const backupPath = `${dbPath}.bak-2026-09-01`;
        copyFileSync(dbPath, backupPath);
        const backup = new Database(backupPath);
        backup.exec(`
            CREATE TABLE legacy_child (
                id INTEGER PRIMARY KEY,
                parent_id INTEGER NOT NULL REFERENCES legacy_parent(id)
            );
            CREATE TABLE legacy_parent (id INTEGER PRIMARY KEY);
            INSERT INTO legacy_parent (id) VALUES (1);
            INSERT INTO legacy_child (id, parent_id) VALUES (1, 1);
        `);
        expect(backup.pragma('foreign_key_check')).toEqual([]);
        backup.close();

        await expect(migratePrimaryDatabaseToEncrypted(dbPath, runtime(directory))).resolves.toEqual({ status: 'migrated' });

        const encrypted = openKeyedDatabase(backupPath, FIXED_KEY, { readonly: true, fileMustExist: true });
        expect(encrypted.prepare('SELECT id, parent_id FROM legacy_child').all()).toEqual([{ id: 1, parent_id: 1 }]);
        expect(encrypted.pragma('foreign_key_check')).toEqual([]);
        encrypted.close();
    });

    it('rejects an unrecognized managed backup before creating migration state or changing the plaintext canonical', async () => {
        const { directory, dbPath } = fixture('elepha-database-migration-invalid-backup-');
        const invalidBackup = `${dbPath}.bak-2026-09-01`;
        const invalidContents = Buffer.from('not a SQLite database');
        writeFileSync(invalidBackup, invalidContents);
        const migrationRuntime = runtime(directory);

        await expect(migratePrimaryDatabaseToEncrypted(dbPath, migrationRuntime)).rejects.toThrow(
            `Managed backup is unrecognized or unverifiable: ${invalidBackup}`,
        );

        assertPlaintextOpenable(dbPath);
        expect(readFileSync(invalidBackup)).toEqual(invalidContents);
        expect(existsSync(migrationRuntime.statePaths?.manifest ?? '')).toBe(false);
        expect(existsSync(migrationRuntime.keyFilePath?.(dbPath) ?? '')).toBe(false);
    });

    it('resumes after one managed backup is durably replaced while the canonical remains plaintext', async () => {
        const { directory, dbPath } = fixture('elepha-database-migration-backup-resume-');
        const expectedBackups = [
            { path: `${dbPath}.bak-2026-09-01`, nativeId: 'resume-older' },
            { path: `${dbPath}.bak-2026-09-02`, nativeId: 'resume-newer' },
        ];
        for (const expected of expectedBackups) {
            copyFileSync(dbPath, expected.path);
            const backup = new Database(expected.path);
            backup.prepare('UPDATE sessions SET native_id = ?').run(expected.nativeId);
            backup.close();
        }
        let replaced = 0;
        const interrupted = runtime(directory, {
            failpoint: (point) => {
                if (point === 'after_managed_backup_replaced' && ++replaced === 1) {
                    expect(hasLifecycleIntent(dbPath)).toBe(true);
                    throw new Error('stop after first managed backup replacement');
                }
            },
        });

        await expect(migratePrimaryDatabaseToEncrypted(dbPath, interrupted)).rejects.toThrow('stop after first managed backup replacement');

        assertPlaintextOpenable(dbPath);
        expect(expectedBackups.map((backup) => isPlaintext(backup.path))).toEqual([false, true]);
        expect(hasLifecycleIntent(dbPath)).toBe(true);
        expect(JSON.parse(readFileSync(interrupted.statePaths?.manifest ?? '', 'utf8'))).toMatchObject({
            stage: 'key_committed',
            backups: [{ stage: 'prepared' }, { stage: 'pending' }],
        });

        await expect(migratePrimaryDatabaseToEncrypted(dbPath, runtime(directory))).resolves.toEqual({ status: 'migrated' });
        await assertEncryptedOpenable(dbPath, runtime(directory));
        expect(expectedBackups.map((backup) => isPlaintext(backup.path))).toEqual([false, false]);
        for (const expected of expectedBackups) {
            const backup = openKeyedDatabase(expected.path, FIXED_KEY, { readonly: true, fileMustExist: true });
            expect(backup.prepare('SELECT native_id FROM sessions').get()).toEqual({ native_id: expected.nativeId });
            backup.close();
        }
        expect(existsSync(interrupted.statePaths?.manifest ?? '')).toBe(false);
        expect(hasLifecycleIntent(dbPath)).toBe(false);
    });

    it.each([
        'after_lock_acquired',
        'after_plaintext_quiesced',
        'after_manifest_quiesced',
        'after_key_generated',
        'after_manifest_key_prepared',
        'after_sidecar_encrypted',
        'after_sidecar_verified',
        'after_rollback_encrypted',
        'after_rollback_verified',
        'after_manifest_rollback_encrypted',
        'after_manifest_sidecar_encrypted',
        'after_key_stored',
        'after_key_read_back',
        'after_encryption_metadata_written',
        'after_manifest_key_committed',
        'after_plaintext_closed',
        'after_manifest_plaintext_closed',
        'after_inactive_wal_removed',
        'after_manifest_wal_cleaned',
        'after_canonical_swap',
        'after_manifest_canonical_swapped',
        'after_committed_database_verified',
        'after_manifest_committed_verified',
        'after_manifest_verified',
        'after_plaintext_rollback_removed',
        'after_manifest_removed',
    ])('recovers deterministically after a kill at %s', async (killPoint) => {
        const { directory, dbPath } = fixture(`elepha-database-kill-${killPoint}-`);
        let killed = false;
        const interrupted = runtime(directory, {
            failpoint: (point) => {
                expect(hasLifecycleIntent(dbPath)).toBe(true);
                if (!killed && point === killPoint) {
                    killed = true;
                    throw new Error(`killed at ${point}`);
                }
            },
        });

        await expect(migratePrimaryDatabaseToEncrypted(dbPath, interrupted)).rejects.toThrow(`killed at ${killPoint}`);
        expect(killed).toBe(true);
        if (isPlaintext(dbPath)) {
            assertPlaintextOpenable(dbPath);
        } else if (hasLifecycleIntent(dbPath)) {
            await expect(openManagedDatabase(dbPath, { readonly: true, fileMustExist: true, encryption: interrupted })).rejects.toThrow(
                DATABASE_LIFECYCLE_AMBIGUOUS,
            );
        } else {
            await assertEncryptedOpenable(dbPath, interrupted);
        }

        const recovered = runtime(directory);
        await migratePrimaryDatabaseToEncrypted(dbPath, recovered);
        if (isPlaintext(dbPath)) {
            expect(killPoint).toBe('after_manifest_sidecar_encrypted');
            assertPlaintextOpenable(dbPath);
        } else {
            await assertEncryptedOpenable(dbPath, recovered);
        }
        expect(existsSync(recovered.statePaths?.manifest ?? '')).toBe(false);
        expect(existsSync(recovered.statePaths?.lock ?? '')).toBe(false);
    });

    it('never leaves a plaintext rollback after the encrypted canonical swap can occur', async () => {
        const { directory, dbPath } = fixture('elepha-database-migration-encrypted-rollback-');
        const statePaths = {
            lock: path.join(directory, 'database-migration.lock'),
            manifest: path.join(directory, 'database-migration.json'),
        };
        const keyPath = path.join(directory, 'database.keydata');
        const source = `
const { migratePrimaryDatabaseToEncrypted } = await import(${JSON.stringify(migrationModule)});
let uuidCalls = 0;
await migratePrimaryDatabaseToEncrypted(${JSON.stringify(dbPath)}, {
    platform: 'linux',
    arch: 'x64',
    libc: 'glibc',
    env: { CI: '1' },
    randomBytes: () => Buffer.from(${JSON.stringify([...FIXED_KEY])}),
    randomUUID: () => uuidCalls++ === 0 ? ${JSON.stringify(MIGRATION_ID)} : ${JSON.stringify(INSTALLATION_ID)},
    keyFilePath: () => ${JSON.stringify(keyPath)},
    statePaths: ${JSON.stringify(statePaths)},
    availableBytes: () => BigInt(Number.MAX_SAFE_INTEGER),
    failpoint: (point) => {
        if (point === 'after_canonical_swap') {
            process.send?.({ point });
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
        }
    },
});`;
        const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', source], {
            cwd: repositoryRoot,
            env: { ...process.env, ELEPHA_HOME: directory },
            stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
        });
        let stderr = '';
        child.stderr?.setEncoding('utf8');
        child.stderr?.on('data', (chunk: string) => {
            stderr += chunk;
        });
        try {
            await new Promise<void>((resolve, reject) => {
                const timeout = setTimeout(() => reject(new Error(`Timed out waiting for canonical swap: ${stderr}`)), 5_000);
                child.once('message', (message) => {
                    clearTimeout(timeout);
                    if ((message as { point?: unknown }).point === 'after_canonical_swap') {
                        resolve();
                    } else {
                        reject(new Error(`Unexpected migration child message: ${JSON.stringify(message)}`));
                    }
                });
                child.once('exit', (code, signal) => {
                    clearTimeout(timeout);
                    reject(new Error(`Migration child exited before canonical swap (${String(code)}/${String(signal)}): ${stderr}`));
                });
                child.once('error', (error) => {
                    clearTimeout(timeout);
                    reject(error);
                });
            });
            await killChild(child);
            expect(child.signalCode).toBe('SIGKILL');

            const manifest = JSON.parse(readFileSync(statePaths.manifest, 'utf8')) as {
                rollbackPath: string;
                sidecarPath: string;
                stage: string;
            };
            expect(manifest.stage).toBe('wal_cleaned');
            expect(isPlaintext(dbPath)).toBe(false);
            const canonical = openKeyedDatabase(dbPath, FIXED_KEY, { readonly: true, fileMustExist: true });
            expect(canonical.prepare('SELECT native_id FROM sessions').get()).toEqual({ native_id: 'migration-session' });
            canonical.close();

            const rollbackArtifacts = [
                manifest.rollbackPath,
                `${manifest.rollbackPath}-wal`,
                `${manifest.rollbackPath}-shm`,
                `${manifest.rollbackPath}-journal`,
            ].filter((artifact) => existsSync(artifact));
            expect(rollbackArtifacts).toContain(manifest.rollbackPath);
            expect(rollbackArtifacts.map((artifact) => isPlaintext(artifact))).toEqual(rollbackArtifacts.map(() => false));
            expect(existsSync(manifest.sidecarPath)).toBe(false);

            await expect(
                migratePrimaryDatabaseToEncrypted(dbPath, {
                    ...runtime(directory),
                    keyFilePath: () => keyPath,
                    statePaths,
                }),
            ).resolves.toEqual({ status: 'migrated' });
        } finally {
            await killChild(child);
        }
    });

    it('recovers a pre-backup-encryption manifest after canonical swap without discarding plaintext recovery', async () => {
        const { directory, dbPath } = fixture('elepha-database-migration-legacy-post-swap-');
        const backupPath = `${dbPath}.bak-2026-09-01`;
        const savedRollbackPath = path.join(directory, 'saved-plaintext-rollback.db');
        const savedBackupPath = path.join(directory, 'saved-plaintext-backup.db');
        copyFileSync(dbPath, backupPath);
        const backup = new Database(backupPath);
        backup.prepare('UPDATE sessions SET native_id = ?').run('legacy-backup-session');
        backup.close();
        const interrupted = runtime(directory, {
            failpoint: (point) => {
                if (point === 'after_manifest_quiesced') {
                    copyFileSync(dbPath, savedRollbackPath);
                    copyFileSync(backupPath, savedBackupPath);
                }
                if (point === 'after_canonical_swap') {
                    throw new Error('stop after legacy canonical swap');
                }
            },
        });

        await expect(migratePrimaryDatabaseToEncrypted(dbPath, interrupted)).rejects.toThrow('stop after legacy canonical swap');
        const manifestPath = interrupted.statePaths?.manifest ?? '';
        const legacyManifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown> & {
            rollbackPath: string;
        };
        copyFileSync(savedRollbackPath, legacyManifest.rollbackPath);
        copyFileSync(savedBackupPath, backupPath);
        delete legacyManifest.rollbackSha256;
        delete legacyManifest.backups;
        writeFileSync(manifestPath, `${JSON.stringify(legacyManifest)}\n`);
        expect(isPlaintext(dbPath)).toBe(false);
        expect(isPlaintext(legacyManifest.rollbackPath)).toBe(true);
        expect(isPlaintext(backupPath)).toBe(true);
        expect(hasLifecycleIntent(dbPath)).toBe(true);

        let inspected = false;
        const inspecting = runtime(directory, {
            failpoint: (point) => {
                if (point === 'after_manifest_backup_replaced') {
                    inspected = true;
                    throw new Error('inspect upgraded recovery artifacts');
                }
            },
        });
        await expect(migratePrimaryDatabaseToEncrypted(dbPath, inspecting)).rejects.toThrow('inspect upgraded recovery artifacts');
        expect(inspected).toBe(true);
        const upgraded = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
            rollbackPath: string;
            rollbackSha256: string;
            backups: Array<{ sourcePath: string; stage: string }>;
        };
        expect(upgraded.rollbackSha256).toMatch(/^[0-9a-f]{64}$/);
        expect(upgraded.backups).toEqual([expect.objectContaining({ sourcePath: backupPath, stage: 'replaced' })]);
        for (const [databasePath, nativeId] of [
            [upgraded.rollbackPath, 'migration-session'],
            [backupPath, 'legacy-backup-session'],
        ] as const) {
            expect(isPlaintext(databasePath)).toBe(false);
            const recovered = openKeyedDatabase(databasePath, FIXED_KEY, { readonly: true, fileMustExist: true });
            expect(recovered.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }]);
            expect(recovered.prepare('SELECT native_id FROM sessions').get()).toEqual({ native_id: nativeId });
            recovered.close();
        }
        expect(hasLifecycleIntent(dbPath)).toBe(true);

        await expect(migratePrimaryDatabaseToEncrypted(dbPath, runtime(directory))).resolves.toEqual({ status: 'migrated' });
        await assertEncryptedOpenable(dbPath, runtime(directory));
        expect(existsSync(manifestPath)).toBe(false);
        expect(hasLifecycleIntent(dbPath)).toBe(false);
    });

    it('retains global ownership across interrupted migration recovery when process homes differ', async () => {
        const { directory, dbPath } = fixture('elepha-database-migration-cross-home-recovery-');
        const homeA = path.join(directory, 'home-a');
        const homeB = path.join(directory, 'home-b');
        mkdirSync(homeA);
        mkdirSync(homeB);
        const migrationRuntime = runtime(homeA, {
            keyFilePath: () => path.join(homeA, 'database.keydata'),
            failpoint: (point) => {
                if (point === 'after_plaintext_closed') {
                    throw new Error('review-cut-after-plaintext-close');
                }
            },
        });
        let firstError: string | null = null;
        try {
            await migratePrimaryDatabaseToEncrypted(dbPath, migrationRuntime);
        } catch (error) {
            firstError = error instanceof Error ? error.message : String(error);
        }
        const intentAfterFailure = hasLifecycleIntent(dbPath);

        process.env.ELEPHA_HOME = homeB;
        let openerError: string | null = null;
        let acknowledged = 0;
        let betweenAttempts: Database.Database | undefined;
        try {
            betweenAttempts = await openManagedDatabase(dbPath, { fileMustExist: true });
            acknowledged = betweenAttempts
                .prepare('INSERT INTO purged_transcripts (tool, native_id, purged_at) VALUES (?, ?, ?)')
                .run('codex', 'ack-between-attempts', '2026-09-05T00:00:00.000Z').changes;
        } catch (error) {
            openerError = error instanceof Error ? error.message : String(error);
        } finally {
            betweenAttempts?.close();
        }

        process.env.ELEPHA_HOME = homeA;
        const result = await migratePrimaryDatabaseToEncrypted(
            dbPath,
            runtime(homeA, { keyFilePath: () => path.join(homeA, 'database.keydata') }),
        );
        const verified = await openManagedDatabase(dbPath, {
            readonly: true,
            fileMustExist: true,
            encryption: runtime(homeA, { keyFilePath: () => path.join(homeA, 'database.keydata') }),
        });
        const rows = verified
            .prepare('SELECT native_id FROM purged_transcripts ORDER BY native_id')
            .all()
            .map((row) => (row as { native_id: string }).native_id);
        verified.close();

        expect({ firstError, intentAfterFailure, acknowledged, result, rows }).toEqual({
            firstError: 'review-cut-after-plaintext-close',
            intentAfterFailure: true,
            acknowledged: 0,
            result: { status: 'migrated' },
            rows: [],
        });
        expect(openerError).toContain(DATABASE_LIFECYCLE_AMBIGUOUS);
    });

    it('preserves writes admitted before the migration rollback baseline is frozen', async () => {
        const { directory, dbPath } = fixture('elepha-database-migration-prefreeze-write-');
        const homeA = path.join(directory, 'home-a');
        const homeB = path.join(directory, 'home-b');
        mkdirSync(homeA);
        mkdirSync(homeB);
        const keyPath = path.join(homeA, 'database.keydata');
        const interrupted = runtime(homeA, {
            keyFilePath: () => keyPath,
            failpoint: (point) => {
                if (point === 'after_manifest_quiesced') {
                    throw new Error('review-cut-before-mutation');
                }
            },
        });
        await expect(migratePrimaryDatabaseToEncrypted(dbPath, interrupted)).rejects.toThrow('review-cut-before-mutation');
        expect(hasLifecycleIntent(dbPath)).toBe(false);

        process.env.ELEPHA_HOME = homeB;
        const betweenAttempts = await openManagedDatabase(dbPath, { fileMustExist: true });
        const acknowledged = betweenAttempts
            .prepare('INSERT INTO purged_transcripts (tool, native_id, purged_at) VALUES (?, ?, ?)')
            .run('codex', 'ack-before-freeze', '2026-09-05T00:00:00.000Z').changes;
        betweenAttempts.close();

        process.env.ELEPHA_HOME = homeA;
        const recovered = runtime(homeA, { keyFilePath: () => keyPath });
        await expect(migratePrimaryDatabaseToEncrypted(dbPath, recovered)).resolves.toEqual({ status: 'migrated' });
        const verified = await openManagedDatabase(dbPath, { readonly: true, fileMustExist: true, encryption: recovered });
        const rows = verified
            .prepare('SELECT native_id FROM purged_transcripts ORDER BY native_id')
            .all()
            .map((row) => (row as { native_id: string }).native_id);
        verified.close();

        expect({ acknowledged, rows }).toEqual({ acknowledged: 1, rows: ['ack-before-freeze'] });
    });

    it('adopts a killed migration only with the originating home manifest capability', async () => {
        const { directory, dbPath } = fixture('elepha-database-migration-killed-capability-');
        const homeA = path.join(directory, 'home-a');
        const homeB = path.join(directory, 'home-b');
        mkdirSync(homeA);
        mkdirSync(homeB);
        const statePaths = {
            lock: path.join(homeA, 'database-migration.lock'),
            manifest: path.join(homeA, 'database-migration.json'),
        };
        const keyPath = path.join(homeA, 'database.keydata');
        const source = `
const { migratePrimaryDatabaseToEncrypted } = await import(${JSON.stringify(migrationModule)});
let uuidCalls = 0;
await migratePrimaryDatabaseToEncrypted(${JSON.stringify(dbPath)}, {
    platform: 'linux',
    arch: 'x64',
    libc: 'glibc',
    env: { CI: '1' },
    randomBytes: () => Buffer.from(${JSON.stringify([...FIXED_KEY])}),
    randomUUID: () => uuidCalls++ === 0 ? ${JSON.stringify(MIGRATION_ID)} : ${JSON.stringify(INSTALLATION_ID)},
    keyFilePath: () => ${JSON.stringify(keyPath)},
    statePaths: ${JSON.stringify(statePaths)},
    availableBytes: () => BigInt(Number.MAX_SAFE_INTEGER),
    failpoint: (point) => {
        if (point === 'after_plaintext_closed') {
            process.send?.({ point });
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
        }
    },
});`;
        const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', source], {
            cwd: repositoryRoot,
            env: { ...process.env, ELEPHA_HOME: homeA },
            stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
        });
        let stderr = '';
        child.stderr?.setEncoding('utf8');
        child.stderr?.on('data', (chunk: string) => {
            stderr += chunk;
        });
        try {
            await new Promise<void>((resolve, reject) => {
                const timeout = setTimeout(() => reject(new Error(`Timed out waiting for killed migration child: ${stderr}`)), 5_000);
                child.once('message', (message) => {
                    clearTimeout(timeout);
                    if ((message as { point?: unknown }).point === 'after_plaintext_closed') {
                        resolve();
                    } else {
                        reject(new Error(`Unexpected killed migration child message: ${JSON.stringify(message)}`));
                    }
                });
                child.once('exit', (code, signal) => {
                    clearTimeout(timeout);
                    reject(new Error(`Migration child exited before failpoint (${String(code)}/${String(signal)}): ${stderr}`));
                });
                child.once('error', (error) => {
                    clearTimeout(timeout);
                    reject(error);
                });
            });
            await killChild(child);
            expect(hasLifecycleIntent(dbPath)).toBe(true);
            const ownerRecords = readdirSync(databaseLifecyclePaths(dbPath).exclusive).map((entry) =>
                readFileSync(path.join(databaseLifecyclePaths(dbPath).exclusive, entry), 'utf8'),
            );
            expect(ownerRecords.join('\n')).not.toContain(MIGRATION_ID);
            expect(ownerRecords.join('\n')).toMatch(/"recoveryHash":"[0-9a-f]{64}"/);

            process.env.ELEPHA_HOME = homeB;
            await expect(
                openManagedDatabase(dbPath, { fileMustExist: true }).then((opened) => {
                    opened.close();
                }),
            ).rejects.toThrow(DATABASE_LIFECYCLE_AMBIGUOUS);
            await expect(acquireExclusiveDatabaseLifecycle(dbPath, INSTALLATION_ID)).rejects.toThrow(DATABASE_LIFECYCLE_AMBIGUOUS);

            process.env.ELEPHA_HOME = homeA;
            const recovered = runtime(homeA, {
                statePaths,
                keyFilePath: () => keyPath,
            });
            await expect(migratePrimaryDatabaseToEncrypted(dbPath, recovered)).resolves.toEqual({ status: 'migrated' });
            await assertEncryptedOpenable(dbPath, recovered);
            expect(hasLifecycleIntent(dbPath)).toBe(false);
        } finally {
            await killChild(child);
        }
    });

    it('restores the byte-exact encrypted canonical and retains the committed key when rename fails', async () => {
        const { directory, dbPath } = fixture('elepha-database-rename-rollback-');
        const failed = runtime(directory, {
            swapDatabase: () => {
                expect(hasLifecycleIntent(dbPath)).toBe(true);
                throw new Error('rename refused');
            },
        });

        await expect(migratePrimaryDatabaseToEncrypted(dbPath, failed)).rejects.toThrow(/restored the encrypted database/);
        expect(existsSync(failed.statePaths?.manifest ?? '')).toBe(true);
        expect(hasLifecycleIntent(dbPath)).toBe(false);
        expect(existsSync(failed.keyFilePath?.(dbPath) ?? '')).toBe(true);
        const manifest = JSON.parse(readFileSync(failed.statePaths?.manifest ?? '', 'utf8')) as {
            rollbackPath: string;
        };
        expect(readFileSync(dbPath)).toEqual(readFileSync(manifest.rollbackPath));
        await assertEncryptedOpenable(dbPath, failed);

        const recovered = runtime(directory);
        await expect(migratePrimaryDatabaseToEncrypted(dbPath, recovered)).resolves.toEqual({ status: 'migrated' });
        await assertEncryptedOpenable(dbPath, recovered);
    });

    it('cleans the exact encrypted rollback restore temporary when its rename fails', async () => {
        const { directory, dbPath } = fixture('elepha-database-rollback-restore-rename-failure-');
        const failed = runtime(directory, {
            swapDatabase: () => {
                throw new Error('encrypted swap refused');
            },
        });
        const primaryError = new Error('injected rollback restore rename failure') as NodeJS.ErrnoException;
        primaryError.code = 'EISDIR';
        const legacyRestoreTemporary = path.join(directory, `.${path.basename(dbPath)}.${MIGRATION_ID}.restore.tmp`);
        const mutableFs = createRequire(import.meta.url)('node:fs') as typeof import('node:fs');
        const originalRenameSync = mutableFs.renameSync;
        let exactTemporary: string | undefined;
        let copiedHeader: string | undefined;
        let copiedNativeId: string | undefined;
        let canonicalBytesAtRestore: Buffer | undefined;
        let rollbackBytesBeforeFailure: Buffer | undefined;
        mutableFs.renameSync = ((oldPath, newPath) => {
            if (String(newPath) === dbPath) {
                exactTemporary = String(oldPath);
                copiedHeader = readFileSync(exactTemporary).subarray(0, 16).toString('binary');
                const copied = openKeyedDatabase(exactTemporary, FIXED_KEY, { readonly: true, fileMustExist: true });
                copiedNativeId = (copied.prepare('SELECT native_id FROM sessions').get() as { native_id: string }).native_id;
                copied.close();
                const manifest = JSON.parse(readFileSync(failed.statePaths?.manifest ?? '', 'utf8')) as { rollbackPath: string };
                rollbackBytesBeforeFailure = readFileSync(manifest.rollbackPath);
                canonicalBytesAtRestore = readFileSync(dbPath);
                for (const suffix of ['-wal', '-shm', '-journal']) {
                    writeFileSync(`${exactTemporary}${suffix}`, `temporary ${suffix}`);
                }
                throw primaryError;
            }
            return originalRenameSync(oldPath, newPath);
        }) as typeof import('node:fs').renameSync;
        syncBuiltinESMExports();

        let caught: unknown;
        try {
            await migratePrimaryDatabaseToEncrypted(dbPath, failed);
        } catch (error) {
            caught = error;
        } finally {
            mutableFs.renameSync = originalRenameSync;
            syncBuiltinESMExports();
        }

        expect(caught).toBe(primaryError);
        if (
            exactTemporary === undefined ||
            copiedHeader === undefined ||
            copiedNativeId === undefined ||
            canonicalBytesAtRestore === undefined ||
            rollbackBytesBeforeFailure === undefined
        ) {
            throw new Error('Rollback restore rename failpoint was not reached.');
        }
        expect(copiedHeader).not.toBe('SQLite format 3\0');
        expect(copiedNativeId).toBe('migration-session');
        const restoreTemporaries = [...new Set([legacyRestoreTemporary, exactTemporary])];
        expect(
            restoreTemporaries
                .flatMap((temporary) => ['', '-wal', '-shm', '-journal'].map((suffix) => `${temporary}${suffix}`))
                .filter(existsSync),
        ).toEqual([]);
        const manifest = JSON.parse(readFileSync(failed.statePaths?.manifest ?? '', 'utf8')) as { rollbackPath: string };
        expect(existsSync(manifest.rollbackPath)).toBe(true);
        expect(readFileSync(manifest.rollbackPath)).toEqual(rollbackBytesBeforeFailure);
        expect(readFileSync(dbPath)).toEqual(canonicalBytesAtRestore);
        assertPlaintextOpenable(dbPath);

        const recovered = runtime(directory);
        await expect(migratePrimaryDatabaseToEncrypted(dbPath, recovered)).resolves.toEqual({ status: 'migrated' });
        await assertEncryptedOpenable(dbPath, recovered);
    });

    it.each(['after_encrypted_rollback_restored', 'after_manifest_rolled_back_key_retained'])(
        'recovers after a kill during rename rollback at %s',
        async (killPoint) => {
            const { directory, dbPath } = fixture(`elepha-database-rollback-kill-${killPoint}-`);
            let killed = false;
            const failed = runtime(directory, {
                swapDatabase: () => {
                    expect(hasLifecycleIntent(dbPath)).toBe(true);
                    throw new Error('rename refused');
                },
                failpoint: (point) => {
                    expect(hasLifecycleIntent(dbPath)).toBe(true);
                    if (!killed && point === killPoint) {
                        killed = true;
                        throw new Error(`killed at ${point}`);
                    }
                },
            });

            await expect(migratePrimaryDatabaseToEncrypted(dbPath, failed)).rejects.toThrow(`killed at ${killPoint}`);
            expect(killed).toBe(true);
            expect(isPlaintext(dbPath)).toBe(false);
            const restored = openKeyedDatabase(dbPath, FIXED_KEY, { readonly: true, fileMustExist: true });
            expect(restored.prepare('SELECT native_id FROM sessions').get()).toEqual({ native_id: 'migration-session' });
            restored.close();

            const recovered = runtime(directory);
            await expect(migratePrimaryDatabaseToEncrypted(dbPath, recovered)).resolves.toEqual({ status: 'migrated' });
            await assertEncryptedOpenable(dbPath, recovered);
        },
    );

    it('blocks with the plaintext canonical when a failed secret-store commit reads back absent', async () => {
        const { directory, dbPath } = fixture('elepha-database-key-absent-');
        const absent: KeyringEntry = {
            getSecret: async () => undefined,
            setSecret: async () => {
                throw new Error('secret store refused write');
            },
            deleteCredential: async () => false,
        };
        const migrationRuntime = runtime(directory, {
            platform: 'darwin',
            createKeyringEntry: async () => absent,
        });

        await expect(migratePrimaryDatabaseToEncrypted(dbPath, migrationRuntime)).rejects.toThrow(DATABASE_KEY_COMMITMENT_INDETERMINATE);
        assertPlaintextOpenable(dbPath);
        expect(JSON.parse(readFileSync(migrationRuntime.statePaths?.manifest ?? '', 'utf8'))).toMatchObject({
            stage: 'key_commitment_started',
            installationId: INSTALLATION_ID,
            backend: 'keyring',
        });
        expect(existsSync(encryptionMetadataPath(dbPath))).toBe(false);

        const recoveredEntry: KeyringEntry = {
            getSecret: async () => Buffer.from(FIXED_KEY),
            setSecret: async () => undefined,
            deleteCredential: async () => false,
        };
        await expect(
            migratePrimaryDatabaseToEncrypted(
                dbPath,
                runtime(directory, { platform: 'darwin', createKeyringEntry: async () => recoveredEntry }),
            ),
        ).resolves.toEqual({ status: 'migrated' });
    });

    it.each(['after_uncommitted_artifacts_removed', 'after_manifest_removed'])(
        'does not reach post-invocation uncommitted cleanup at %s',
        async (forbiddenCleanupPoint) => {
            const { directory, dbPath } = fixture(`elepha-database-key-cleanup-${forbiddenCleanupPoint}-`);
            let cleanupReached = false;
            const absent: KeyringEntry = {
                getSecret: async () => undefined,
                setSecret: async () => {
                    throw new Error('secret store refused write');
                },
                deleteCredential: async () => false,
            };
            const interrupted = runtime(directory, {
                platform: 'darwin',
                createKeyringEntry: async () => absent,
                failpoint: (point) => {
                    if (point === forbiddenCleanupPoint) {
                        cleanupReached = true;
                    }
                },
            });

            await expect(migratePrimaryDatabaseToEncrypted(dbPath, interrupted)).rejects.toThrow(DATABASE_KEY_COMMITMENT_INDETERMINATE);
            expect(cleanupReached).toBe(false);
            assertPlaintextOpenable(dbPath);
            expect(JSON.parse(readFileSync(interrupted.statePaths?.manifest ?? '', 'utf8'))).toMatchObject({
                stage: 'key_commitment_started',
                installationId: INSTALLATION_ID,
            });

            const matching: KeyringEntry = {
                getSecret: async () => Buffer.from(FIXED_KEY),
                setSecret: async () => undefined,
                deleteCredential: async () => false,
            };
            const recovered = runtime(directory, { platform: 'darwin', createKeyringEntry: async () => matching });
            await expect(migratePrimaryDatabaseToEncrypted(dbPath, recovered)).resolves.toEqual({ status: 'migrated' });
            expect(existsSync(recovered.statePaths?.manifest ?? '')).toBe(false);
        },
    );

    it('blocks after a crash between the commitment manifest fsync and key-store invocation', async () => {
        const { directory, dbPath } = fixture('elepha-database-key-before-invocation-');
        let setCalls = 0;
        const absent: KeyringEntry = {
            getSecret: async () => undefined,
            setSecret: async () => {
                setCalls++;
            },
            deleteCredential: async () => false,
        };
        const interrupted = runtime(directory, {
            platform: 'darwin',
            createKeyringEntry: async () => absent,
            failpoint: (point) => {
                if (point === 'after_manifest_key_commitment_started') {
                    throw new Error('crash before key-store invocation');
                }
            },
        });

        await expect(migratePrimaryDatabaseToEncrypted(dbPath, interrupted)).rejects.toThrow('crash before key-store invocation');
        expect(setCalls).toBe(0);
        assertPlaintextOpenable(dbPath);
        const manifestPath = interrupted.statePaths?.manifest ?? '';
        const beforeRetry = readFileSync(manifestPath, 'utf8');
        expect(JSON.parse(beforeRetry)).toMatchObject({
            stage: 'key_commitment_started',
            installationId: INSTALLATION_ID,
            backend: 'keyring',
            keySha256: createHash('sha256').update(FIXED_KEY).digest('hex'),
        });

        await expect(
            migratePrimaryDatabaseToEncrypted(
                dbPath,
                runtime(directory, {
                    platform: 'darwin',
                    createKeyringEntry: async () => absent,
                    randomBytes: () => {
                        throw new Error('blocked migration generated another key');
                    },
                }),
            ),
        ).rejects.toThrow(DATABASE_KEY_COMMITMENT_INDETERMINATE);
        expect(setCalls).toBe(0);
        expect(readFileSync(manifestPath, 'utf8')).toBe(beforeRetry);
        assertPlaintextOpenable(dbPath);

        const mismatching: KeyringEntry = {
            getSecret: async () => Buffer.from(FIXED_KEY).fill(0xff),
            setSecret: async () => undefined,
            deleteCredential: async () => false,
        };
        await expect(
            migratePrimaryDatabaseToEncrypted(
                dbPath,
                runtime(directory, {
                    platform: 'darwin',
                    createKeyringEntry: async () => mismatching,
                    randomBytes: () => {
                        throw new Error('mismatched migration generated another key');
                    },
                }),
            ),
        ).rejects.toThrow('The stored database key does not match the active migration manifest.');
        expect(readFileSync(manifestPath, 'utf8')).toBe(beforeRetry);
        assertPlaintextOpenable(dbPath);

        const matching: KeyringEntry = {
            getSecret: async () => Buffer.from(FIXED_KEY),
            setSecret: async () => undefined,
            deleteCredential: async () => false,
        };
        await expect(
            migratePrimaryDatabaseToEncrypted(dbPath, runtime(directory, { platform: 'darwin', createKeyringEntry: async () => matching })),
        ).resolves.toEqual({ status: 'migrated' });
    });

    it('continues when the key write reports failure but read-back returns the intended key', async () => {
        const { directory, dbPath } = fixture('elepha-database-key-succeeded-');
        let stored: Buffer | undefined;
        const entry: KeyringEntry = {
            getSecret: async () => stored,
            setSecret: async (secret) => {
                stored = Buffer.from(secret);
                throw new Error('response lost after write');
            },
            deleteCredential: async () => false,
        };
        const migrationRuntime = runtime(directory, {
            platform: 'darwin',
            createKeyringEntry: async () => entry,
        });

        await expect(migratePrimaryDatabaseToEncrypted(dbPath, migrationRuntime)).resolves.toEqual({ status: 'migrated' });
        await assertEncryptedOpenable(dbPath, migrationRuntime);
        expect(stored).toEqual(FIXED_KEY);
    });

    it('retains one key and identity when a timed-out secret-store write commits late before an absent read-back', async () => {
        const { directory, dbPath } = fixture('elepha-database-key-late-commit-');
        const secondMigrationId = '33333333-3333-4333-8333-333333333333';
        const secondInstallationId = '44444444-4444-4444-8444-444444444444';
        const secondKey = Buffer.from(Array.from({ length: 32 }, (_, index) => 255 - index));
        const identities = [MIGRATION_ID, INSTALLATION_ID, secondMigrationId, secondInstallationId];
        const generatedKeys = [FIXED_KEY, secondKey];
        const credentials = new Map<string, Buffer>();
        const credentialReads = new Map<string, number>();
        const accessedIdentities = new Set<string>();
        const cleanupPoints: string[] = [];
        const events: string[] = [];
        let uuidCalls = 0;
        let keyCalls = 0;
        let setCalls = 0;
        let releaseSetStart: (() => void) | undefined;
        let releaseSetSettlement: (() => void) | undefined;
        let releaseSetSettled: (() => void) | undefined;
        let firstSetSecret: Uint8Array | undefined;
        const setStarted = new Promise<void>((resolve) => {
            releaseSetStart = resolve;
        });
        const allowSetSettlement = new Promise<void>((resolve) => {
            releaseSetSettlement = resolve;
        });
        const setSettled = new Promise<void>((resolve) => {
            releaseSetSettled = resolve;
        });
        const migrationRuntime = runtime(directory, {
            platform: 'darwin',
            randomUUID: () => {
                const identity = identities[uuidCalls++];
                if (identity === undefined) {
                    throw new Error('migration generated a third identity');
                }
                return identity;
            },
            randomBytes: () => {
                const key = generatedKeys[keyCalls++];
                if (key === undefined) {
                    throw new Error('migration generated a third key');
                }
                return Buffer.from(key);
            },
            createKeyringEntry: async (_service, account) => {
                accessedIdentities.add(account);
                return {
                    getSecret: async () => {
                        const reads = (credentialReads.get(account) ?? 0) + 1;
                        credentialReads.set(account, reads);
                        if (account === INSTALLATION_ID && reads <= 2) {
                            events.push(reads === 1 ? 'initial read absent' : 'immediate read absent after late commit');
                            if (reads === 2 && credentials.get(account)?.equals(FIXED_KEY)) {
                                events.push('late commit proven before absent read');
                            }
                            return undefined;
                        }
                        return credentials.get(account);
                    },
                    setSecret: async (secret, signal) => {
                        setCalls++;
                        if (account !== INSTALLATION_ID) {
                            credentials.set(account, Buffer.from(secret));
                            return;
                        }
                        const manifestAtInvocation = JSON.parse(readFileSync(migrationRuntime.statePaths?.manifest ?? '', 'utf8')) as {
                            stage: string;
                        };
                        events.push(`first set observed ${manifestAtInvocation.stage}`);
                        events.push('first set started');
                        firstSetSecret = secret;
                        releaseSetStart?.();
                        await new Promise<void>((resolve) => {
                            const commitLate = () => {
                                queueMicrotask(() => {
                                    credentials.set(account, Buffer.from(secret));
                                    events.push('first set committed after timeout');
                                    resolve();
                                });
                            };
                            if (signal?.aborted) {
                                commitLate();
                            } else {
                                signal?.addEventListener('abort', commitLate, { once: true });
                            }
                        });
                        await allowSetSettlement;
                        events.push('first set settled');
                        releaseSetSettled?.();
                    },
                    deleteCredential: async () => false,
                };
            },
            failpoint: (point) => {
                if (point === 'after_uncommitted_artifacts_removed' || point === 'after_manifest_removed') {
                    cleanupPoints.push(point);
                }
            },
        });

        vi.useFakeTimers();
        try {
            const firstAttempt = migratePrimaryDatabaseToEncrypted(dbPath, migrationRuntime).then(
                (result) => ({ result, error: undefined }),
                (error: unknown) => ({ result: undefined, error: error instanceof Error ? error.message : String(error) }),
            );
            await setStarted;
            await vi.advanceTimersByTimeAsync(DATABASE_KEYRING_TIMEOUT_MS);
            const { result: firstResult, error: firstError } = await firstAttempt;
            const manifestPath = migrationRuntime.statePaths?.manifest ?? '';
            const storedManifest = existsSync(manifestPath)
                ? (JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>)
                : undefined;
            const retainedManifest = storedManifest
                ? {
                      stage: storedManifest.stage,
                      installationId: storedManifest.installationId,
                      backend: storedManifest.backend,
                      keySha256: storedManifest.keySha256,
                  }
                : undefined;
            const plaintextAfterIndeterminateWrite = isPlaintext(dbPath);
            const cleanupAfterFirstAttempt = [...cleanupPoints];
            const retainedKeyAfterFirstAttempt = Buffer.from(firstSetSecret ?? []);

            const retryResult = await migratePrimaryDatabaseToEncrypted(dbPath, migrationRuntime);
            releaseSetSettlement?.();
            await setSettled;
            await Promise.resolve();
            const erasedKeyAfterSettlement = Buffer.from(firstSetSecret ?? []);

            expect({
                firstResult,
                firstError,
                retainedManifest,
                plaintextAfterIndeterminateWrite,
                cleanupAfterFirstAttempt,
                retainedKeyAfterFirstAttempt,
                erasedKeyAfterSettlement,
                events,
                retryResult,
                uuidCalls,
                keyCalls,
                setCalls,
                accessedIdentities: [...accessedIdentities],
                credentialIdentities: [...credentials.keys()],
            }).toEqual({
                firstResult: undefined,
                firstError: DATABASE_KEY_COMMITMENT_INDETERMINATE,
                retainedManifest: {
                    stage: 'key_commitment_started',
                    installationId: INSTALLATION_ID,
                    backend: 'keyring',
                    keySha256: createHash('sha256').update(FIXED_KEY).digest('hex'),
                },
                plaintextAfterIndeterminateWrite: true,
                cleanupAfterFirstAttempt: [],
                retainedKeyAfterFirstAttempt: FIXED_KEY,
                erasedKeyAfterSettlement: Buffer.alloc(FIXED_KEY.length),
                events: [
                    'initial read absent',
                    'first set observed key_commitment_started',
                    'first set started',
                    'first set committed after timeout',
                    'immediate read absent after late commit',
                    'late commit proven before absent read',
                    'first set settled',
                ],
                retryResult: { status: 'migrated' },
                uuidCalls: 2,
                keyCalls: 1,
                setCalls: 1,
                accessedIdentities: [INSTALLATION_ID],
                credentialIdentities: [INSTALLATION_ID],
            });
            await assertEncryptedOpenable(dbPath, migrationRuntime);
        } finally {
            vi.useRealTimers();
        }
    });

    it('blocks with the plaintext canonical when a successful key write reads back absent', async () => {
        const { directory, dbPath } = fixture('elepha-database-key-readback-absent-');
        const entry: KeyringEntry = {
            getSecret: async () => undefined,
            setSecret: async () => undefined,
            deleteCredential: async () => false,
        };
        const migrationRuntime = runtime(directory, {
            platform: 'darwin',
            createKeyringEntry: async () => entry,
        });

        await expect(migratePrimaryDatabaseToEncrypted(dbPath, migrationRuntime)).rejects.toThrow(DATABASE_KEY_COMMITMENT_INDETERMINATE);
        assertPlaintextOpenable(dbPath);
        expect(JSON.parse(readFileSync(migrationRuntime.statePaths?.manifest ?? '', 'utf8'))).toMatchObject({
            stage: 'key_commitment_started',
            installationId: INSTALLATION_ID,
        });

        const recoveredEntry: KeyringEntry = {
            getSecret: async () => Buffer.from(FIXED_KEY),
            setSecret: async () => undefined,
            deleteCredential: async () => false,
        };
        await expect(
            migratePrimaryDatabaseToEncrypted(
                dbPath,
                runtime(directory, { platform: 'darwin', createKeyringEntry: async () => recoveredEntry }),
            ),
        ).resolves.toEqual({ status: 'migrated' });
    });

    it('freezes with the manifest and plaintext rollback when key read-back is indeterminate', async () => {
        const { directory, dbPath } = fixture('elepha-database-key-indeterminate-');
        let reads = 0;
        const entry: KeyringEntry = {
            getSecret: async () => {
                reads++;
                if (reads === 1) {
                    return undefined;
                }
                throw new Error('secret store unavailable');
            },
            setSecret: async () => {
                throw new Error('secret store write indeterminate');
            },
            deleteCredential: async () => false,
        };
        const migrationRuntime = runtime(directory, {
            platform: 'darwin',
            createKeyringEntry: async () => entry,
        });

        await expect(migratePrimaryDatabaseToEncrypted(dbPath, migrationRuntime)).rejects.toThrow(DATABASE_KEY_COMMITMENT_INDETERMINATE);
        assertPlaintextOpenable(dbPath);
        expect(existsSync(migrationRuntime.statePaths?.manifest ?? '')).toBe(true);
        const manifest = JSON.parse(readFileSync(migrationRuntime.statePaths?.manifest ?? '', 'utf8')) as { rollbackPath: string };
        expect(existsSync(manifest.rollbackPath)).toBe(true);

        const recoveredEntry: KeyringEntry = {
            getSecret: async () => Buffer.from(FIXED_KEY),
            setSecret: async () => undefined,
            deleteCredential: async () => false,
        };
        await expect(
            migratePrimaryDatabaseToEncrypted(
                dbPath,
                runtime(directory, { platform: 'darwin', createKeyringEntry: async () => recoveredEntry }),
            ),
        ).resolves.toEqual({ status: 'migrated' });
    });

    it('blocks read-only and writable managed openers while a primary manifest is active', async () => {
        const { directory, dbPath } = fixture('elepha-database-opener-lock-');
        process.env.ELEPHA_HOME = directory;
        process.env.ELEPHA_DB_PATH = dbPath;
        const paths = elephaPaths();
        const migrationRuntime = runtime(directory, {
            statePaths: { lock: paths.migrationLock, manifest: paths.migrationManifest },
            failpoint: (point) => {
                if (point === 'after_manifest_quiesced') {
                    throw new Error('stop with active manifest');
                }
            },
        });
        await expect(migratePrimaryDatabaseToEncrypted(dbPath, migrationRuntime)).rejects.toThrow('stop with active manifest');
        const manifestText = readFileSync(paths.migrationManifest, 'utf8');
        expect(JSON.parse(manifestText)).toMatchObject({ backend: 'key-file', sourcePath: dbPath, stage: 'quiesced' });
        expect(manifestText).not.toContain(FIXED_KEY.toString('hex'));
        expect(statSync(paths.migrationManifest).mode & 0o777).toBe(0o600);

        await expect(openManagedDatabase(dbPath, { readonly: true, fileMustExist: true })).rejects.toThrow('migration_in_progress');
        await expect(openManagedDatabase(dbPath, { fileMustExist: true })).rejects.toThrow('migration_in_progress');
    });

    it('publishes exclusive intent and drains a managed opener before migration inspection', async () => {
        const { directory, dbPath } = fixture('elepha-database-migration-managed-opener-');
        const migrationRuntime = runtime(directory);
        const opener = await openManagedDatabase(dbPath, { fileMustExist: true });
        const migration = migratePrimaryDatabaseToEncrypted(dbPath, migrationRuntime);
        await waitForLifecycleIntent(dbPath);

        expect(existsSync(migrationRuntime.statePaths?.manifest ?? '')).toBe(false);
        expect(existsSync(migrationRuntime.keyFilePath?.(dbPath) ?? '')).toBe(false);
        await expect(openManagedDatabase(dbPath, { fileMustExist: true })).rejects.toThrow(DATABASE_LIFECYCLE_BUSY);
        opener.close();

        await expect(migration).resolves.toEqual({ status: 'migrated' });
        await assertEncryptedOpenable(dbPath, migrationRuntime);
    });

    it('waits for a retiring unmanaged WAL reader before changing journal mode', async () => {
        const { directory, dbPath } = fixture('elepha-database-migration-retiring-reader-');
        const migrationRuntime = runtime(directory);
        const source = `
import Database from 'better-sqlite3-multiple-ciphers';
const database = new Database(${JSON.stringify(dbPath)}, { readonly: true, fileMustExist: true });
database.exec('BEGIN');
database.prepare('SELECT COUNT(*) FROM sessions').get();
process.send?.({ ready: true });
setTimeout(() => {
    database.exec('ROLLBACK');
    database.close();
}, 250);
`;
        const child = spawn(process.execPath, ['--input-type=module', '--eval', source], {
            cwd: repositoryRoot,
            env: { ...process.env, ELEPHA_HOME: directory },
            stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
        });
        let stderr = '';
        child.stderr?.setEncoding('utf8');
        child.stderr?.on('data', (chunk: string) => {
            stderr += chunk;
        });
        try {
            await new Promise<void>((resolve, reject) => {
                const timeout = setTimeout(() => reject(new Error(`Timed out waiting for retiring reader: ${stderr}`)), 5_000);
                child.once('message', (message) => {
                    clearTimeout(timeout);
                    if ((message as { ready?: unknown }).ready === true) {
                        resolve();
                    } else {
                        reject(new Error(`Unexpected retiring reader message: ${JSON.stringify(message)}`));
                    }
                });
                child.once('exit', (code, signal) => {
                    clearTimeout(timeout);
                    reject(new Error(`Retiring reader exited before acquisition (${String(code)}/${String(signal)}): ${stderr}`));
                });
                child.once('error', (error) => {
                    clearTimeout(timeout);
                    reject(error);
                });
            });

            await expect(migratePrimaryDatabaseToEncrypted(dbPath, migrationRuntime)).resolves.toEqual({ status: 'migrated' });
            await assertEncryptedOpenable(dbPath, migrationRuntime);
        } finally {
            await killChild(child);
        }
    }, 15_000);

    it('preserves acknowledged alias WAL data when a reader prevents the native close checkpoint', async () => {
        const { directory, dbPath } = fixture('elepha-database-migration-closed-alias-wal-');
        const aliasPath = path.join(directory, 'alias.db');
        linkSync(dbPath, aliasPath);
        const migrationRuntime = runtime(directory);
        const writer = await openManagedDatabase(aliasPath, { fileMustExist: true });
        const reader = await openManagedDatabase(dbPath, { readonly: true, fileMustExist: true });
        try {
            writer.pragma('wal_autocheckpoint = 0');
            reader.exec('BEGIN');
            reader.prepare('SELECT COUNT(*) FROM purged_transcripts').get();
            expect(
                writer
                    .prepare('INSERT INTO purged_transcripts (tool, native_id, purged_at) VALUES (?, ?, ?)')
                    .run('codex', 'closed-alias-tombstone', '2026-09-05T00:00:00.000Z').changes,
            ).toBe(1);

            expect(() => writer.close()).toThrow(DATABASE_LIFECYCLE_BUSY);
            expect(writer.open).toBe(true);
            expect(statSync(`${aliasPath}-wal`).size).toBeGreaterThan(0);
            const migration = migratePrimaryDatabaseToEncrypted(dbPath, migrationRuntime);
            await waitForLifecycleIntent(dbPath);
            expect(existsSync(migrationRuntime.statePaths?.manifest ?? '')).toBe(false);
            expect(existsSync(migrationRuntime.keyFilePath?.(dbPath) ?? '')).toBe(false);
            reader.close();
            writer.close();
            await expect(migration).resolves.toEqual({ status: 'migrated' });
            const verified = await openManagedDatabase(dbPath, { readonly: true, fileMustExist: true, encryption: migrationRuntime });
            try {
                expect(verified.prepare('SELECT native_id FROM purged_transcripts').all()).toEqual([
                    { native_id: 'closed-alias-tombstone' },
                ]);
            } finally {
                verified.close();
            }
        } finally {
            reader.close();
            writer.close();
        }
    });

    it('pins a relative database path before awaited lifecycle acquisition', async () => {
        const target = fixture('elepha-database-migration-relative-target-');
        const other = fixture('elepha-database-migration-relative-other-');
        const otherAlias = path.join(other.directory, 'old-hard-link.db');
        linkSync(other.dbPath, otherAlias);
        const otherOriginalIdentity = statSync(other.dbPath);
        const migrationRuntime = runtime(target.directory);
        const opener = await openManagedDatabase(target.dbPath, { fileMustExist: true });
        const originalCwd = process.cwd();
        let migration: ReturnType<typeof migratePrimaryDatabaseToEncrypted> | undefined;
        let result: Awaited<ReturnType<typeof migratePrimaryDatabaseToEncrypted>> | undefined;

        try {
            process.chdir(target.directory);
            migration = migratePrimaryDatabaseToEncrypted(path.basename(target.dbPath), migrationRuntime);
            await waitForLifecycleIntent(target.dbPath);
            process.chdir(other.directory);
            opener.close();
            result = await migration;
        } finally {
            process.chdir(originalCwd);
            if (opener.open) {
                opener.close();
            }
            await migration?.catch(() => undefined);
        }

        let detachedAliasWrite = false;
        if (!isPlaintext(other.dbPath)) {
            const alias = await openDb(otherAlias, { fileMustExist: true, encryption: migrationRuntime });
            try {
                const changes = alias
                    .prepare('INSERT INTO purged_transcripts (tool, native_id, purged_at) VALUES (?, ?, ?)')
                    .run('codex', 'ack-after-relative-migration', '2026-09-04T00:00:00.000Z').changes;
                const currentIdentity = statSync(other.dbPath);
                detachedAliasWrite =
                    changes === 1 &&
                    (currentIdentity.dev !== otherOriginalIdentity.dev || currentIdentity.ino !== otherOriginalIdentity.ino);
            } finally {
                alias.close();
            }
        }

        expect({
            result,
            targetPlaintext: isPlaintext(target.dbPath),
            otherPlaintext: isPlaintext(other.dbPath),
            detachedAliasWrite,
        }).toEqual({
            result: { status: 'migrated' },
            targetPlaintext: false,
            otherPlaintext: true,
            detachedAliasWrite: false,
        });
    });

    it('recovers a complete stale exclusive lock left before manifest creation', async () => {
        const { directory, dbPath } = fixture('elepha-database-stale-lock-');
        const migrationRuntime = runtime(directory);
        const lock = migrationRuntime.statePaths?.lock;
        if (!lock) {
            throw new Error('test migration lock path is unavailable');
        }
        writeFileSync(lock, `${JSON.stringify({ version: 1, pid: 2_147_483_647 })}\n`, { mode: 0o600 });

        await expect(migratePrimaryDatabaseToEncrypted(dbPath, migrationRuntime)).resolves.toEqual({ status: 'migrated' });
        expect(existsSync(lock)).toBe(false);
        await assertEncryptedOpenable(dbPath, migrationRuntime);
    });

    it('stops before manifest creation and copying when exclusive access fails', async () => {
        const { directory, dbPath } = fixture('elepha-database-exclusive-');
        const blocker = new Database(dbPath, { fileMustExist: true });
        blocker.exec('BEGIN IMMEDIATE');
        const migrationRuntime = runtime(directory);
        try {
            await expect(migratePrimaryDatabaseToEncrypted(dbPath, migrationRuntime)).rejects.toThrow(/locked/);
            expect(existsSync(migrationRuntime.statePaths?.manifest ?? '')).toBe(false);
            expect(existsSync(migrationRuntime.keyFilePath?.(dbPath) ?? '')).toBe(false);
            expect(existsSync(path.join(directory, `.${path.basename(dbPath)}.migration-${MIGRATION_ID}.plaintext`))).toBe(false);
        } finally {
            blocker.exec('ROLLBACK');
            blocker.close();
        }
    });

    it.each([
        { runtimeName: 'ia32', overrides: { arch: 'ia32' } },
        { runtimeName: 'native Win32', overrides: { platform: 'win32' } },
    ] as const)('refuses the unsupported $runtimeName runtime before creating migration state', async ({ runtimeName, overrides }) => {
        const { directory, dbPath } = fixture(`elepha-database-preflight-${runtimeName}-`);
        const paths = runtime(directory).statePaths;
        await expect(migratePrimaryDatabaseToEncrypted(dbPath, runtime(directory, overrides))).rejects.toThrow(/unsupported/);
        expect(existsSync(paths?.manifest ?? '')).toBe(false);
        expect(existsSync(paths?.lock ?? '')).toBe(false);
        expect(existsSync(encryptionKeyPath(dbPath))).toBe(false);
    });

    it('refuses insufficient space before creating migration state', async () => {
        const { directory, dbPath } = fixture('elepha-database-preflight-space-');
        const paths = runtime(directory).statePaths;
        await expect(migratePrimaryDatabaseToEncrypted(dbPath, runtime(directory, { availableBytes: () => 0n }))).rejects.toThrow(
            /requires .* free bytes/,
        );
        expect(existsSync(paths?.manifest ?? '')).toBe(false);
        expect(existsSync(paths?.lock ?? '')).toBe(false);
        expect(existsSync(encryptionKeyPath(dbPath))).toBe(false);
    });

    it('treats a pre-existing encrypted primary as a no-op without migration files', async () => {
        const directory = withGrantableTestDir('elepha-database-already-encrypted-');
        const dbPath = path.join(directory, 'elepha.db');
        const migrationRuntime = runtime(directory);
        const encrypted = await openDb(dbPath, { encryption: migrationRuntime });
        encrypted.close();

        await expect(migratePrimaryDatabaseToEncrypted(dbPath, migrationRuntime)).resolves.toEqual({ status: 'already-encrypted' });
        expect(existsSync(migrationRuntime.statePaths?.manifest ?? '')).toBe(false);
        expect(existsSync(migrationRuntime.statePaths?.lock ?? '')).toBe(false);
    });

    it('does not migrate an absent primary', async () => {
        const directory = withGrantableTestDir('elepha-database-absent-');
        const dbPath = path.join(directory, 'elepha.db');
        mkdirSync(directory, { recursive: true });
        writeFileSync(path.join(directory, 'unrelated'), 'kept');

        await expect(migratePrimaryDatabaseToEncrypted(dbPath, runtime(directory))).resolves.toEqual({ status: 'no-database' });
        expect(existsSync(dbPath)).toBe(false);
    });
});
