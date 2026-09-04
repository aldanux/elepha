import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3-multiple-ciphers';
import { afterEach, describe, expect, it } from 'vitest';
import { elephaPaths } from '../../src/config/paths.js';
import { encryptionKeyPath, encryptionMetadataPath, type KeyringEntry } from '../../src/storage/database-encryption.js';
import { type DatabaseMigrationRuntime, migratePrimaryDatabaseToEncrypted } from '../../src/storage/database-migration.js';
import { openDb, openManagedDatabase, openUnmanagedDb } from '../../src/storage/db.js';
import { withGrantableTestDir } from '../helpers/tmp.js';

const FIXED_KEY = Buffer.from(Array.from({ length: 32 }, (_, index) => index + 1));
const MIGRATION_ID = '11111111-1111-4111-8111-111111111111';
const INSTALLATION_ID = '22222222-2222-4222-8222-222222222222';
const savedEnvironment = { ...process.env };

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

    it.each([
        'after_lock_acquired',
        'after_plaintext_quiesced',
        'after_manifest_quiesced',
        'after_plaintext_rollback_copied',
        'after_manifest_rollback_copied',
        'after_working_sidecar_copied',
        'after_manifest_sidecar_copied',
        'after_key_generated',
        'after_manifest_key_prepared',
        'after_sidecar_encrypted',
        'after_sidecar_verified',
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

    it('restores the byte-exact plaintext canonical and retains the committed key when rename fails', async () => {
        const { directory, dbPath } = fixture('elepha-database-rename-rollback-');
        const failed = runtime(directory, {
            swapDatabase: () => {
                throw new Error('rename refused');
            },
        });

        await expect(migratePrimaryDatabaseToEncrypted(dbPath, failed)).rejects.toThrow(/restored the plaintext database/);
        assertPlaintextOpenable(dbPath);
        expect(existsSync(failed.statePaths?.manifest ?? '')).toBe(true);
        expect(existsSync(failed.keyFilePath?.(dbPath) ?? '')).toBe(true);
        const manifest = JSON.parse(readFileSync(failed.statePaths?.manifest ?? '', 'utf8')) as {
            originalSha256: string;
            rollbackPath: string;
        };
        expect(readFileSync(dbPath)).toEqual(readFileSync(manifest.rollbackPath));

        const recovered = runtime(directory);
        await expect(migratePrimaryDatabaseToEncrypted(dbPath, recovered)).resolves.toEqual({ status: 'migrated' });
        await assertEncryptedOpenable(dbPath, recovered);
    });

    it.each(['after_plaintext_rollback_restored', 'after_manifest_rolled_back_key_retained'])(
        'recovers after a kill during rename rollback at %s',
        async (killPoint) => {
            const { directory, dbPath } = fixture(`elepha-database-rollback-kill-${killPoint}-`);
            let killed = false;
            const failed = runtime(directory, {
                swapDatabase: () => {
                    throw new Error('rename refused');
                },
                failpoint: (point) => {
                    if (!killed && point === killPoint) {
                        killed = true;
                        throw new Error(`killed at ${point}`);
                    }
                },
            });

            await expect(migratePrimaryDatabaseToEncrypted(dbPath, failed)).rejects.toThrow(`killed at ${killPoint}`);
            expect(killed).toBe(true);
            assertPlaintextOpenable(dbPath);

            const recovered = runtime(directory);
            await expect(migratePrimaryDatabaseToEncrypted(dbPath, recovered)).resolves.toEqual({ status: 'migrated' });
            await assertEncryptedOpenable(dbPath, recovered);
        },
    );

    it('finishes unchanged when a failed secret-store commit is confirmed absent', async () => {
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

        await expect(migratePrimaryDatabaseToEncrypted(dbPath, migrationRuntime)).resolves.toEqual({ status: 'recovered-plaintext' });
        assertPlaintextOpenable(dbPath);
        expect(existsSync(migrationRuntime.statePaths?.manifest ?? '')).toBe(false);
        expect(existsSync(encryptionMetadataPath(dbPath))).toBe(false);
    });

    it.each(['after_uncommitted_artifacts_removed', 'after_manifest_removed'])(
        'recovers after a kill during confirmed-absent key cleanup at %s',
        async (killPoint) => {
            const { directory, dbPath } = fixture(`elepha-database-key-cleanup-${killPoint}-`);
            let killed = false;
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
                    if (!killed && point === killPoint) {
                        killed = true;
                        throw new Error(`killed at ${point}`);
                    }
                },
            });

            await expect(migratePrimaryDatabaseToEncrypted(dbPath, interrupted)).rejects.toThrow(`killed at ${killPoint}`);
            expect(killed).toBe(true);
            assertPlaintextOpenable(dbPath);

            const recovered = runtime(directory, { platform: 'darwin', createKeyringEntry: async () => absent });
            await expect(migratePrimaryDatabaseToEncrypted(dbPath, recovered)).resolves.toEqual({ status: 'recovered-plaintext' });
            assertPlaintextOpenable(dbPath);
            expect(existsSync(recovered.statePaths?.manifest ?? '')).toBe(false);
        },
    );

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

    it('finishes unchanged when a successful key write cannot be read back', async () => {
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

        await expect(migratePrimaryDatabaseToEncrypted(dbPath, migrationRuntime)).resolves.toEqual({ status: 'recovered-plaintext' });
        assertPlaintextOpenable(dbPath);
        expect(existsSync(migrationRuntime.statePaths?.manifest ?? '')).toBe(false);
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

        await expect(migratePrimaryDatabaseToEncrypted(dbPath, migrationRuntime)).rejects.toThrow(/commit is indeterminate/);
        assertPlaintextOpenable(dbPath);
        expect(existsSync(migrationRuntime.statePaths?.manifest ?? '')).toBe(true);
        const manifest = JSON.parse(readFileSync(migrationRuntime.statePaths?.manifest ?? '', 'utf8')) as { rollbackPath: string };
        expect(existsSync(manifest.rollbackPath)).toBe(true);
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

    it('refuses unsupported runtimes and insufficient space before creating migration state', async () => {
        const { directory, dbPath } = fixture('elepha-database-preflight-');
        const paths = runtime(directory).statePaths;
        await expect(migratePrimaryDatabaseToEncrypted(dbPath, runtime(directory, { arch: 'ia32' }))).rejects.toThrow(/unsupported/);
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
