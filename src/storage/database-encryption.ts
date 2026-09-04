import { randomBytes, randomUUID } from 'node:crypto';
import {
    closeSync,
    existsSync,
    constants as fsConstants,
    fstatSync,
    fsyncSync,
    lstatSync,
    mkdirSync,
    openSync,
    readFileSync,
    renameSync,
    unlinkSync,
    writeFileSync,
} from 'node:fs';
import path from 'node:path';
import type { Message } from 'dbus-native';
import { DATABASE_KEY_BYTES, DATABASE_KEYRING_TIMEOUT_MS, PRIVATE_DIR_MODE, PRIVATE_FILE_MODE } from '../config/constants.js';
import { errorMessage } from '../util/error.js';

export const DATABASE_CREDENTIAL_SERVICE = 'dev.elepha.database';
export const DATABASE_ENCRYPTION_METADATA_FILE = 'encryption.json';
export const DATABASE_KEY_FILE = 'elepha.key';
const DBUS_NO_AUTO_START_FLAG = 0x02;

type EncryptionBackend = 'keyring' | 'key-file';

interface EncryptionMetadata {
    installationId: string;
    backend: EncryptionBackend;
    mode: 'default';
}

interface KeyringEntry {
    setSecret(secret: Uint8Array, signal?: AbortSignal | null): Promise<void>;
    getSecret(signal?: AbortSignal | null): Promise<Uint8Array | null | undefined>;
    deleteCredential(signal?: AbortSignal | null): Promise<boolean>;
}

type SecretServiceProbe = () => Promise<boolean>;

export interface DatabaseEncryptionRuntime {
    platform?: NodeJS.Platform;
    env?: NodeJS.ProcessEnv;
    procVersion?: () => string;
    probeSecretService?: SecretServiceProbe;
    createKeyringEntry?: (service: string, account: string) => Promise<KeyringEntry>;
    randomBytes?: (size: number) => Buffer;
    randomUUID?: () => string;
    keyFilePath?: (databasePath: string) => string;
}

interface SecretServiceSearchResult {
    unlocked: string[];
    locked: string[];
}

function encryptionPaths(databasePath: string): { metadata: string; key: string } {
    const directory = path.dirname(databasePath);
    return {
        metadata: path.join(directory, DATABASE_ENCRYPTION_METADATA_FILE),
        key: path.join(directory, DATABASE_KEY_FILE),
    };
}

function noFollowFlag(): number {
    return fsConstants.O_NOFOLLOW ?? 0;
}

function assertPrivateRegularFile(file: string, opened: ReturnType<typeof fstatSync>): void {
    const current = lstatSync(file);
    if (!opened.isFile() || !current.isFile() || current.isSymbolicLink()) {
        throw new Error(`Refusing non-regular encryption file: ${file}`);
    }
    if (opened.dev !== current.dev || opened.ino !== current.ino) {
        throw new Error(`Encryption file changed while opening it: ${file}`);
    }
    if ((Number(opened.mode) & 0o777) !== PRIVATE_FILE_MODE) {
        throw new Error(`Encryption file must have mode 0600: ${file}`);
    }
    const uid = process.getuid?.();
    if (uid !== undefined && opened.uid !== uid) {
        throw new Error(`Encryption file is not owned by the current user: ${file}`);
    }
}

function readPrivateFile(file: string): Buffer | undefined {
    let descriptor: number;
    try {
        descriptor = openSync(file, fsConstants.O_RDONLY | noFollowFlag());
    } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return undefined;
        }
        throw new Error(`Cannot open encryption file ${file}: ${errorMessage(error)}`);
    }
    try {
        const opened = fstatSync(descriptor);
        assertPrivateRegularFile(file, opened);
        return readFileSync(descriptor);
    } finally {
        closeSync(descriptor);
    }
}

function fsyncDirectory(directory: string): void {
    const descriptor = openSync(directory, fsConstants.O_RDONLY);
    try {
        fsyncSync(descriptor);
    } finally {
        closeSync(descriptor);
    }
}

function failPrivateFileInstallation(temporary: string, file: string, error: unknown): never {
    try {
        unlinkSync(temporary);
    } catch (cleanupError: unknown) {
        if ((cleanupError as NodeJS.ErrnoException).code !== 'ENOENT') {
            throw new AggregateError([error, cleanupError], `Encryption file installation and cleanup failed: ${file}`);
        }
    }
    throw error;
}

function writePrivateFileAtomic(file: string, contents: Buffer): void {
    const directory = path.dirname(file);
    mkdirSync(directory, { recursive: true, mode: PRIVATE_DIR_MODE });
    const temporary = path.join(directory, `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`);
    let descriptor: number | undefined;
    let temporaryIdentity: ReturnType<typeof fstatSync>;
    try {
        descriptor = openSync(
            temporary,
            fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollowFlag(),
            PRIVATE_FILE_MODE,
        );
        writeFileSync(descriptor, contents);
        fsyncSync(descriptor);
        temporaryIdentity = fstatSync(descriptor);
        closeSync(descriptor);
        descriptor = undefined;
    } catch (error) {
        if (descriptor !== undefined) {
            closeSync(descriptor);
        }
        failPrivateFileInstallation(temporary, file, error);
    }
    if (existsSync(file)) {
        failPrivateFileInstallation(temporary, file, new Error(`Refusing to replace existing encryption file: ${file}`));
    }
    try {
        renameSync(temporary, file);
        fsyncDirectory(directory);
    } catch (error) {
        failPrivateFileInstallation(temporary, file, error);
    }
    const verifyDescriptor = openSync(file, fsConstants.O_RDONLY | noFollowFlag());
    try {
        const opened = fstatSync(verifyDescriptor);
        assertPrivateRegularFile(file, opened);
        if (opened.dev !== temporaryIdentity.dev || opened.ino !== temporaryIdentity.ino) {
            throw new Error(`Encryption file identity changed during installation: ${file}`);
        }
        const stored = readFileSync(verifyDescriptor);
        if (!stored.equals(contents)) {
            throw new Error(`Encryption file failed read-back verification: ${file}`);
        }
    } finally {
        closeSync(verifyDescriptor);
    }
}

function readMetadata(file: string): EncryptionMetadata | undefined {
    const contents = readPrivateFile(file);
    if (contents === undefined) {
        return undefined;
    }
    let value: unknown;
    try {
        value = JSON.parse(contents.toString('utf8'));
    } catch (error) {
        throw new Error(`Cannot parse encryption metadata ${file}: ${errorMessage(error)}`);
    }
    if (
        typeof value !== 'object' ||
        value === null ||
        !('installationId' in value) ||
        typeof value.installationId !== 'string' ||
        !('backend' in value) ||
        (value.backend !== 'keyring' && value.backend !== 'key-file') ||
        !('mode' in value) ||
        value.mode !== 'default'
    ) {
        throw new Error(`Encryption metadata has an unsupported format: ${file}`);
    }
    return value as EncryptionMetadata;
}

function isWsl(env: NodeJS.ProcessEnv, procVersion: () => string): boolean {
    if (env.WSL_DISTRO_NAME !== undefined || env.WSL_INTEROP !== undefined) {
        return true;
    }
    try {
        return /microsoft|wsl/i.test(procVersion());
    } catch {
        return false;
    }
}

async function withTimeout<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
            controller.abort();
            reject(new Error(`Secret-store operation timed out after ${DATABASE_KEYRING_TIMEOUT_MS}ms.`));
        }, DATABASE_KEYRING_TIMEOUT_MS);
    });
    try {
        return await Promise.race([operation(controller.signal), timeout]);
    } finally {
        if (timer !== undefined) {
            clearTimeout(timer);
        }
    }
}

async function defaultKeyringEntry(service: string, account: string): Promise<KeyringEntry> {
    const { AsyncEntry } = await import('@napi-rs/keyring');
    return new AsyncEntry(service, account);
}

async function defaultLinuxSecretServiceProbe(): Promise<boolean> {
    if (!process.env.DBUS_SESSION_BUS_ADDRESS?.trim()) {
        return false;
    }
    const { messageType, sessionBus } = await import('dbus-native');
    const bus = sessionBus({ busAddress: process.env.DBUS_SESSION_BUS_ADDRESS, variants: 'wrap' });
    const call = async (message: Message): Promise<unknown[]> => {
        const reply = await withTimeout((signal) => Promise.resolve(bus.invoke<unknown>(message, { signal })));
        return Array.isArray(reply) ? reply : [reply];
    };
    const serviceMessage = (member: string, signature: string, body: unknown[]): Message => ({
        type: messageType.methodCall,
        destination: 'org.freedesktop.secrets',
        path: '/org/freedesktop/secrets',
        interface: 'org.freedesktop.Secret.Service',
        member,
        signature,
        body,
        flags: DBUS_NO_AUTO_START_FLAG,
    });
    const searchItems = async (service: string, account: string): Promise<SecretServiceSearchResult> => {
        const [unlocked, locked] = await call(serviceMessage('SearchItems', 'a{ss}', [{ service, username: account }]));
        if (!Array.isArray(unlocked) || !Array.isArray(locked)) {
            throw new Error('Secret Service returned an invalid SearchItems result.');
        }
        return { unlocked: unlocked as string[], locked: locked as string[] };
    };
    const canaryService = `${DATABASE_CREDENTIAL_SERVICE}.probe`;
    const canaryAccount = randomUUID();
    const canarySecret = randomBytes(DATABASE_KEY_BYTES);
    let canary: KeyringEntry | undefined;
    let stored = false;
    let deleted = false;
    try {
        const [hasOwner] = await call({
            type: messageType.methodCall,
            destination: 'org.freedesktop.DBus',
            path: '/org/freedesktop/DBus',
            interface: 'org.freedesktop.DBus',
            member: 'NameHasOwner',
            signature: 's',
            body: ['org.freedesktop.secrets'],
            flags: DBUS_NO_AUTO_START_FLAG,
        });
        if (hasOwner !== true) {
            return false;
        }
        const [collection] = await call(serviceMessage('ReadAlias', 's', ['default']));
        if (typeof collection !== 'string' || collection === '/') {
            return false;
        }
        const [locked] = await call({
            type: messageType.methodCall,
            destination: 'org.freedesktop.secrets',
            path: collection,
            interface: 'org.freedesktop.DBus.Properties',
            member: 'Get',
            signature: 'ss',
            body: ['org.freedesktop.Secret.Collection', 'Locked'],
            flags: DBUS_NO_AUTO_START_FLAG,
        });
        if (typeof locked !== 'object' || locked === null || !('value' in locked) || locked.value !== false) {
            return false;
        }
        const entry = await defaultKeyringEntry(canaryService, canaryAccount);
        canary = entry;
        await withTimeout((signal) => entry.setSecret(canarySecret, signal));
        stored = true;
        const readBack = await withTimeout((signal) => entry.getSecret(signal));
        if (readBack == null || !Buffer.from(readBack).equals(canarySecret)) {
            return false;
        }
        const found = await searchItems(canaryService, canaryAccount);
        if (found.unlocked.length === 0 || found.locked.length !== 0) {
            return false;
        }
        deleted = await withTimeout((signal) => entry.deleteCredential(signal));
        if (!deleted) {
            return false;
        }
        const absent = await searchItems(canaryService, canaryAccount);
        return absent.unlocked.length === 0 && absent.locked.length === 0;
    } catch {
        return false;
    } finally {
        if (stored && !deleted && canary !== undefined) {
            const cleanupEntry = canary;
            await withTimeout((signal) => cleanupEntry.deleteCredential(signal)).catch(() => false);
        }
        canarySecret.fill(0);
        await bus.close();
    }
}

async function selectBackend(runtime: DatabaseEncryptionRuntime): Promise<EncryptionBackend> {
    const platform = runtime.platform ?? process.platform;
    const env = runtime.env ?? process.env;
    if (platform === 'darwin' || platform === 'win32') {
        return 'keyring';
    }
    if (platform !== 'linux') {
        return 'key-file';
    }
    const procVersion = runtime.procVersion ?? (() => readFileSync('/proc/version', 'utf8'));
    if (isWsl(env, procVersion) || Object.hasOwn(env, 'CI')) {
        return 'key-file';
    }
    try {
        return (await (runtime.probeSecretService ?? defaultLinuxSecretServiceProbe)()) ? 'keyring' : 'key-file';
    } catch {
        return 'key-file';
    }
}

async function keyringSecret(metadata: EncryptionMetadata, creating: boolean, runtime: DatabaseEncryptionRuntime): Promise<Buffer> {
    const entry = await (runtime.createKeyringEntry ?? defaultKeyringEntry)(DATABASE_CREDENTIAL_SERVICE, metadata.installationId);
    const existing = await withTimeout((signal) => entry.getSecret(signal));
    if (existing != null) {
        const key = Buffer.from(existing);
        if (key.length !== DATABASE_KEY_BYTES) {
            throw new Error(`Stored elepha database key has ${key.length} bytes; expected ${DATABASE_KEY_BYTES}.`);
        }
        return key;
    }
    if (!creating) {
        throw new Error('The encrypted elepha database key is missing from the recorded OS secret store.');
    }
    const key = (runtime.randomBytes ?? randomBytes)(DATABASE_KEY_BYTES);
    await withTimeout((signal) => entry.setSecret(key, signal));
    const stored = await withTimeout((signal) => entry.getSecret(signal));
    if (stored == null || !Buffer.from(stored).equals(key)) {
        key.fill(0);
        throw new Error('The OS secret store failed database-key read-back verification.');
    }
    return key;
}

function keyFileSecret(file: string, creating: boolean, runtime: DatabaseEncryptionRuntime): Buffer {
    const existing = readPrivateFile(file);
    if (existing !== undefined) {
        if (existing.length !== DATABASE_KEY_BYTES) {
            throw new Error(`Stored elepha database key has ${existing.length} bytes; expected ${DATABASE_KEY_BYTES}: ${file}`);
        }
        return existing;
    }
    if (!creating) {
        throw new Error(`The encrypted elepha database key is missing: ${file}`);
    }
    const key = (runtime.randomBytes ?? randomBytes)(DATABASE_KEY_BYTES);
    writePrivateFileAtomic(file, key);
    return key;
}

export async function databaseKey(databasePath: string, creating: boolean, runtime: DatabaseEncryptionRuntime = {}): Promise<Buffer> {
    const paths = encryptionPaths(databasePath);
    const keyPath = runtime.keyFilePath?.(databasePath) ?? paths.key;
    let metadata = readMetadata(paths.metadata);
    if (metadata === undefined) {
        if (!creating) {
            throw new Error(`Encryption metadata is missing for the encrypted elepha database: ${paths.metadata}`);
        }
        metadata = {
            installationId: (runtime.randomUUID ?? randomUUID)(),
            backend: await selectBackend(runtime),
            mode: 'default',
        };
        writePrivateFileAtomic(paths.metadata, Buffer.from(`${JSON.stringify(metadata)}\n`, 'utf8'));
    }
    return metadata.backend === 'keyring' ? keyringSecret(metadata, creating, runtime) : keyFileSecret(keyPath, creating, runtime);
}

export function encryptionMetadataPath(databasePath: string): string {
    return encryptionPaths(databasePath).metadata;
}

export function encryptionKeyPath(databasePath: string): string {
    return encryptionPaths(databasePath).key;
}
