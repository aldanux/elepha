import { chmodSync, existsSync, readdirSync, readFileSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3-multiple-ciphers';
import { describe, expect, it } from 'vitest';
import { openMcpReadOnlyDatabase } from '../../src/mcp/server.js';
import {
    DATABASE_CREDENTIAL_SERVICE,
    DATABASE_ENCRYPTION_PLATFORM_ERROR,
    type DatabaseEncryptionRuntime,
    databaseKey,
    encryptionKeyPath,
    encryptionMetadataPath,
    readStoredDatabaseKey,
    selectBackend,
    storeDatabaseKey,
} from '../../src/storage/database-encryption.js';
import { openDb, openUnmanagedDb } from '../../src/storage/db.js';
import { withGrantableTestDir } from '../helpers/tmp.js';

const FIXED_KEY = Buffer.from(Array.from({ length: 32 }, (_, index) => index));

function keyFileRuntime(overrides: Partial<DatabaseEncryptionRuntime> = {}): DatabaseEncryptionRuntime {
    return {
        platform: 'linux',
        env: { CI: '1' },
        randomBytes: () => Buffer.from(FIXED_KEY),
        randomUUID: () => '11111111-1111-4111-8111-111111111111',
        keyFilePath: (dbPath) => path.join(path.dirname(dbPath), 'elepha.keydata'),
        ...overrides,
    };
}

function keyringRuntime(secrets: Map<string, Buffer>, installationId: string): DatabaseEncryptionRuntime {
    return {
        platform: 'darwin',
        randomBytes: () => Buffer.from(FIXED_KEY),
        randomUUID: () => installationId,
        createKeyringEntry: async (_service, account) => ({
            getSecret: async () => secrets.get(account),
            setSecret: async (secret) => {
                secrets.set(account, Buffer.from(secret));
            },
            deleteCredential: async () => secrets.delete(account),
        }),
    };
}

function metadata(dbPath: string): { installationId: string; backend: string; mode: string } {
    return JSON.parse(readFileSync(encryptionMetadataPath(dbPath), 'utf8')) as {
        installationId: string;
        backend: string;
        mode: string;
    };
}

describe('managed database encryption', () => {
    it('creates an encrypted database that reopens read/write and read-only with FTS5 intact', async () => {
        const directory = withGrantableTestDir('elepha-encrypted-db-');
        const dbPath = path.join(directory, 'elepha.db');
        const secrets = new Map<string, Buffer>();
        const runtime = keyringRuntime(secrets, '11111111-1111-4111-8111-111111111111');
        const writable = await openDb(dbPath, { encryption: runtime });
        writable.exec(`
            INSERT INTO projects (id, path, first_seen_at, last_seen_at) VALUES (1, '/project', 'now', 'now');
            INSERT INTO sessions (id, tool, native_id, project_id, source_path, started_at, last_ingested_at)
            VALUES (1, 'codex', 'encrypted-session', 1, '/transcript', 'now', 'now');
            INSERT INTO memories
                (id, project_id, session_id, turn_index, tool, turn_started_at, decisions, files_touched, pending_items, created_at)
            VALUES (1, 1, 1, 0, 'codex', 'now', '[]', '[]', '[]', 'now');
            INSERT INTO filtered_turns (memory_id, included, user_prompt, assistant_response, filter_version, captured_at)
            VALUES (1, 1, 'encrypted elephant', 'answer', 1, 'now');
        `);
        writable.close();

        expect(readFileSync(dbPath).subarray(0, 16).toString('binary')).not.toBe('SQLite format 3\0');
        expect(statSync(encryptionMetadataPath(dbPath)).mode & 0o777).toBe(0o600);
        expect(metadata(dbPath)).toEqual({
            installationId: '11111111-1111-4111-8111-111111111111',
            backend: 'keyring',
            mode: 'default',
        });

        const unkeyed = new Database(dbPath, { readonly: true, fileMustExist: true });
        expect(() => unkeyed.prepare('SELECT name FROM sqlite_master').all()).toThrow();
        unkeyed.close();

        const reopened = await openDb(dbPath, { encryption: runtime });
        expect(
            reopened.prepare("SELECT COUNT(*) AS count FROM filtered_turns_fts WHERE filtered_turns_fts MATCH 'elephant'").get(),
        ).toEqual({
            count: 1,
        });
        reopened.close();

        const readOnly = await openMcpReadOnlyDatabase(dbPath, runtime);
        expect(readOnly.prepare('SELECT native_id FROM sessions').get()).toEqual({ native_id: 'encrypted-session' });
        expect(() => readOnly.prepare("UPDATE sessions SET native_id = 'changed'").run()).toThrow(/readonly/i);
        readOnly.close();
    });

    it('opens an existing plaintext database without provisioning a key or changing its bytes', async () => {
        const directory = withGrantableTestDir('elepha-plaintext-db-');
        const dbPath = path.join(directory, 'elepha.db');
        const legacy = openUnmanagedDb(dbPath);
        legacy.close();
        const before = readFileSync(dbPath);

        const opened = await openDb(dbPath, {
            encryption: keyFileRuntime({
                randomBytes: () => {
                    throw new Error('plaintext open must not provision');
                },
            }),
        });
        opened.close();

        expect(readFileSync(dbPath)).toEqual(before);
        expect(existsSync(encryptionMetadataPath(dbPath))).toBe(false);
        expect(existsSync(encryptionKeyPath(dbPath))).toBe(false);
    });

    it('fails closed instead of regenerating a missing key for an encrypted database', async () => {
        const directory = withGrantableTestDir('elepha-missing-db-key-');
        const dbPath = path.join(directory, 'elepha.db');
        const secrets = new Map<string, Buffer>();
        const runtime = keyringRuntime(secrets, 'missing-key-installation');
        const created = await openDb(dbPath, { encryption: runtime });
        created.close();
        const encryptedBytes = readFileSync(dbPath);
        secrets.clear();

        await expect(openDb(dbPath, { encryption: runtime })).rejects.toThrow(/key is missing/);
        expect(secrets.size).toBe(0);
        expect(readFileSync(dbPath)).toEqual(encryptedBytes);
    });

    it('records Linux fallback once and never widens or replaces an unsafe existing key file', async () => {
        const directory = withGrantableTestDir('elepha-key-file-safety-');
        const dbPath = path.join(directory, 'elepha.db');
        const metadataPath = encryptionMetadataPath(dbPath);
        const runtime = keyFileRuntime();
        const keyPath = runtime.keyFilePath?.(dbPath);
        if (keyPath === undefined) {
            throw new Error('test key path is unavailable');
        }
        writeFileSync(metadataPath, '{"installationId":"install","backend":"key-file","mode":"default"}\n', { mode: 0o600 });
        writeFileSync(keyPath, FIXED_KEY, { mode: 0o644 });
        chmodSync(keyPath, 0o644);

        await expect(databaseKey(dbPath, true, runtime)).rejects.toThrow(/mode 0600/);
        expect(statSync(keyPath).mode & 0o777).toBe(0o644);
        expect(readFileSync(keyPath)).toEqual(FIXED_KEY);

        unlinkSync(keyPath);
        const target = path.join(directory, 'target.keydata');
        writeFileSync(target, FIXED_KEY, { mode: 0o600 });
        symlinkSync(target, keyPath);
        await expect(databaseKey(dbPath, true, runtime)).rejects.toThrow(/Cannot open encryption file/);
        expect(readFileSync(target)).toEqual(FIXED_KEY);
    });

    it('uses the OS store on Darwin and aborts instead of falling back when it is unavailable', async () => {
        const directory = withGrantableTestDir('elepha-keyring-failure-');
        const dbPath = path.join(directory, 'elepha.db');
        const runtime: DatabaseEncryptionRuntime = {
            platform: 'darwin',
            createKeyringEntry: async (service, account) => {
                expect(service).toBe(DATABASE_CREDENTIAL_SERVICE);
                expect(account).toBe('22222222-2222-4222-8222-222222222222');
                return {
                    getSecret: async () => {
                        throw new Error('locked');
                    },
                    setSecret: async () => undefined,
                    deleteCredential: async () => false,
                };
            },
            randomUUID: () => '22222222-2222-4222-8222-222222222222',
        };

        await expect(openDb(dbPath, { encryption: runtime })).rejects.toThrow(/locked/);
        expect(metadata(dbPath).backend).toBe('keyring');
        expect(existsSync(encryptionKeyPath(dbPath))).toBe(false);
        expect(existsSync(dbPath)).toBe(false);
    });

    it('rejects native Win32 before inspecting existing encryption state', async () => {
        const directory = withGrantableTestDir('elepha-unsupported-win32-');
        const dbPath = path.join(directory, 'elepha.db');
        const metadataPath = encryptionMetadataPath(dbPath);
        const databaseBytes = Buffer.from('existing encrypted database bytes');
        const metadataBytes = Buffer.from('{"installationId":"win32-install","backend":"keyring","mode":"default"}\n');
        writeFileSync(dbPath, databaseBytes, { mode: 0o600 });
        writeFileSync(metadataPath, metadataBytes, { mode: 0o600 });
        const filesBefore = readdirSync(directory);
        const events: string[] = [];
        let returnedKey: Buffer | undefined;
        let failure: unknown;

        try {
            returnedKey = await databaseKey(dbPath, false, {
                platform: 'win32',
                keyFilePath: () => {
                    events.push('key-file path');
                    return path.join(directory, 'unexpected.key');
                },
                createKeyringEntry: async () => {
                    events.push('keyring entry');
                    return {
                        getSecret: async () => {
                            events.push('credential read');
                            return FIXED_KEY;
                        },
                        setSecret: async () => {
                            events.push('credential write');
                        },
                        deleteCredential: async () => false,
                    };
                },
            });
        } catch (error) {
            failure = error;
        }

        expect({
            returnedKey: returnedKey?.equals(FIXED_KEY) ?? false,
            error: failure instanceof Error ? failure.message : undefined,
            events,
        }).toEqual({
            returnedKey: false,
            error: DATABASE_ENCRYPTION_PLATFORM_ERROR,
            events: [],
        });
        expect(readFileSync(dbPath)).toEqual(databaseBytes);
        expect(readFileSync(metadataPath)).toEqual(metadataBytes);
        expect(readdirSync(directory)).toEqual(filesBefore);
    });

    it('rejects native Win32 before parsing existing encryption metadata', async () => {
        const directory = withGrantableTestDir('elepha-unsupported-win32-metadata-');
        const dbPath = path.join(directory, 'elepha.db');
        const metadataPath = encryptionMetadataPath(dbPath);
        const malformedMetadata = Buffer.from('{not valid encryption metadata');
        writeFileSync(metadataPath, malformedMetadata, { mode: 0o600 });
        const filesBefore = readdirSync(directory);

        await expect(databaseKey(dbPath, false, { platform: 'win32' })).rejects.toThrow(DATABASE_ENCRYPTION_PLATFORM_ERROR);
        expect(readFileSync(metadataPath)).toEqual(malformedMetadata);
        expect(readdirSync(directory)).toEqual(filesBefore);
    });

    it('rejects other unsupported platforms during backend selection', async () => {
        await expect(selectBackend({ platform: 'freebsd' })).rejects.toThrow(DATABASE_ENCRYPTION_PLATFORM_ERROR);
    });

    it('rejects native Win32 stored-key operations before accessing a backend', async () => {
        const directory = withGrantableTestDir('elepha-unsupported-stored-key-');
        const dbPath = path.join(directory, 'elepha.db');
        const filesBefore = readdirSync(directory);
        const events: string[] = [];
        const metadata = { installationId: 'win32-install', backend: 'keyring', mode: 'default' } as const;
        const runtime: DatabaseEncryptionRuntime = {
            platform: 'win32',
            keyFilePath: () => {
                events.push('key-file path');
                return path.join(directory, 'unexpected.key');
            },
            createKeyringEntry: async () => {
                events.push('keyring entry');
                throw new Error('unsupported runtime reached the credential backend');
            },
        };

        await expect(readStoredDatabaseKey(dbPath, metadata, runtime)).rejects.toThrow(DATABASE_ENCRYPTION_PLATFORM_ERROR);
        await expect(storeDatabaseKey(dbPath, metadata, FIXED_KEY, runtime)).rejects.toThrow(DATABASE_ENCRYPTION_PLATFORM_ERROR);
        expect(events).toEqual([]);
        expect(readdirSync(directory)).toEqual(filesBefore);
    });

    it.each([
        { label: 'CI', env: { CI: '' }, procVersion: (): string => 'Linux' },
        { label: 'WSL', env: {}, procVersion: (): string => 'Linux microsoft-standard-WSL2' },
    ])('uses the key-file backend on Linux $label without probing Secret Service', async ({ env, procVersion }) => {
        const directory = withGrantableTestDir('elepha-linux-key-file-');
        const dbPath = path.join(directory, 'elepha.db');
        const runtime = keyFileRuntime({
            env,
            procVersion,
            probeSecretService: async () => {
                throw new Error('probe must not run');
            },
        });

        const db = await openDb(dbPath, { encryption: runtime });
        db.close();
        expect(metadata(dbPath).backend).toBe('key-file');
    });

    it('uses Secret Service only after the Linux probe succeeds', async () => {
        const directory = withGrantableTestDir('elepha-secret-service-');
        const dbPath = path.join(directory, 'elepha.db');
        const secrets = new Map<string, Buffer>();
        const runtime: DatabaseEncryptionRuntime = {
            platform: 'linux',
            env: {},
            probeSecretService: async () => true,
            randomBytes: () => Buffer.from(FIXED_KEY),
            randomUUID: () => '33333333-3333-4333-8333-333333333333',
            createKeyringEntry: async (_service, account) => ({
                getSecret: async () => secrets.get(account),
                setSecret: async (secret) => {
                    secrets.set(account, Buffer.from(secret));
                },
                deleteCredential: async () => secrets.delete(account),
            }),
        };

        const db = await openDb(dbPath, { encryption: runtime });
        db.close();
        expect(metadata(dbPath).backend).toBe('keyring');
        expect(secrets.get('33333333-3333-4333-8333-333333333333')).toEqual(FIXED_KEY);
        expect(existsSync(encryptionKeyPath(dbPath))).toBe(false);
    });

    it('records a Linux key-file fallback after a failed Secret Service probe', async () => {
        const directory = withGrantableTestDir('elepha-secret-service-fallback-');
        const dbPath = path.join(directory, 'elepha.db');
        const runtime = keyFileRuntime({
            env: {},
            probeSecretService: async () => {
                throw new Error('D-Bus unavailable');
            },
        });

        const db = await openDb(dbPath, { encryption: runtime });
        db.close();
        expect(metadata(dbPath).backend).toBe('key-file');
        const keyPath = runtime.keyFilePath?.(dbPath);
        expect(keyPath).toBeDefined();
        expect(readFileSync(keyPath ?? '')).toEqual(FIXED_KEY);
        expect(statSync(keyPath ?? '').mode & 0o777).toBe(0o600);

        const reopened = await openDb(dbPath, {
            encryption: {
                ...runtime,
                platform: 'darwin',
                createKeyringEntry: async () => {
                    throw new Error('recorded backend must not change');
                },
            },
        });
        reopened.close();
        expect(metadata(dbPath).backend).toBe('key-file');
    });
});
