// Mutable application-level read gate authenticated by the database key.
// The key remains available to capture and maintenance processes: paranoid
// mode deliberately gates serving, not database access or writes.

import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import type Database from 'better-sqlite3-multiple-ciphers';
import {
    PARANOID_HMAC_BYTES,
    PARANOID_SCRYPT_MAXMEM_BYTES,
    PARANOID_SCRYPT_N,
    PARANOID_SCRYPT_OUTPUT_BYTES,
    PARANOID_SCRYPT_P,
    PARANOID_SCRYPT_R,
    PARANOID_SCRYPT_SALT_BYTES,
    PARANOID_STATE_FILE_NAME,
} from '../config/constants.js';
import { readPrivateFile, writePrivateFileAtomic } from './database-encryption.js';

export const LOCKED_MEMORY_MESSAGE = "elepha memory is locked. Run 'elepha unlock' in a terminal, then retry.";
export const NON_TTY_UNLOCK_MESSAGE = "Refusing to unlock without a controlling terminal. Run 'elepha unlock' yourself in a terminal.";
export const WRONG_PASSPHRASE_MESSAGE = 'Unlock failed: incorrect passphrase. Memory remains locked.';

export interface LockedContentCoverage {
    state: 'locked';
}

export const LOCKED_CONTENT_COVERAGE: LockedContentCoverage = Object.freeze({ state: 'locked' });
export const LOCKED_MCP_RESULT = Object.freeze({
    empty: true,
    reason: 'locked',
    content_coverage: LOCKED_CONTENT_COVERAGE,
});

type GateMode = 'default' | 'paranoid';
type GateServeState = 'locked' | 'unlocked';

interface GatePayload {
    mode: GateMode;
    salt: string;
    verifier: string;
    epoch: number;
    state: GateServeState;
}

interface GateFile extends GatePayload {
    hmac: string;
}

interface RegisteredDatabase {
    databasePath: string;
    key: Buffer;
}

interface ParsedGateState {
    payload: GatePayload;
    authentic: boolean;
}

const DATABASE_REGISTRY_SYMBOL = Symbol.for('dev.elepha.paranoid.database-registry');

// Test runners and bundled consumers can load this module through more than
// one module graph. Keep one process-local registry so the factory that opens
// a connection and the read surface that checks it always share key context.
function databaseRegistry(): WeakMap<Database.Database, RegisteredDatabase> {
    const existing = Reflect.get(globalThis, DATABASE_REGISTRY_SYMBOL) as WeakMap<Database.Database, RegisteredDatabase> | undefined;
    if (existing !== undefined) {
        return existing;
    }
    const created = new WeakMap<Database.Database, RegisteredDatabase>();
    Object.defineProperty(globalThis, DATABASE_REGISTRY_SYMBOL, { value: created });
    return created;
}

const registeredDatabases = databaseRegistry();

export function paranoidStatePath(databasePath: string): string {
    return path.join(path.dirname(databasePath), PARANOID_STATE_FILE_NAME);
}

// Keep a process-local copy for synchronous read checks. The connection also
// retains the same key internally; this copy exists solely to authenticate the
// mutable gate file before a read reaches SQLite or a transcript.
export function registerParanoidDatabase(db: Database.Database, databasePath: string, key: Buffer): void {
    registeredDatabases.set(db, { databasePath, key: Buffer.from(key) });
}

function payloadBytes(payload: GatePayload): Buffer {
    return Buffer.from(JSON.stringify(payload), 'utf8');
}

function signature(payload: GatePayload, key: Buffer): Buffer {
    return createHmac('sha256', key).update(payloadBytes(payload)).digest();
}

function encodedSignature(payload: GatePayload, key: Buffer): string {
    return signature(payload, key).toString('base64');
}

function decodedBytes(value: string, expectedBytes: number): Buffer | undefined {
    try {
        const decoded = Buffer.from(value, 'base64');
        return decoded.length === expectedBytes && decoded.toString('base64') === value ? decoded : undefined;
    } catch {
        return undefined;
    }
}

function parsedGateFile(contents: Buffer, key: Buffer): ParsedGateState | undefined {
    let value: unknown;
    try {
        value = JSON.parse(contents.toString('utf8'));
    } catch {
        return undefined;
    }
    if (
        !value ||
        typeof value !== 'object' ||
        !('mode' in value) ||
        (value.mode !== 'default' && value.mode !== 'paranoid') ||
        !('salt' in value) ||
        typeof value.salt !== 'string' ||
        !('verifier' in value) ||
        typeof value.verifier !== 'string' ||
        !('epoch' in value) ||
        typeof value.epoch !== 'number' ||
        !Number.isSafeInteger(value.epoch) ||
        value.epoch < 1 ||
        !('state' in value) ||
        (value.state !== 'locked' && value.state !== 'unlocked') ||
        !('hmac' in value) ||
        typeof value.hmac !== 'string'
    ) {
        return undefined;
    }
    const salt = decodedBytes(value.salt, PARANOID_SCRYPT_SALT_BYTES);
    const verifier = decodedBytes(value.verifier, PARANOID_SCRYPT_OUTPUT_BYTES);
    const storedHmac = decodedBytes(value.hmac, PARANOID_HMAC_BYTES);
    if (salt === undefined || verifier === undefined || storedHmac === undefined) {
        return undefined;
    }
    const payload: GatePayload = {
        mode: value.mode,
        salt: value.salt,
        verifier: value.verifier,
        epoch: value.epoch,
        state: value.state,
    };
    const expectedHmac = signature(payload, key);
    return { payload, authentic: timingSafeEqual(storedHmac, expectedHmac) };
}

function readRegisteredState(db: Database.Database): ParsedGateState | undefined {
    const registered = registeredDatabases.get(db);
    if (registered === undefined) {
        return undefined;
    }
    const file = paranoidStatePath(registered.databasePath);
    let contents: Buffer | undefined;
    try {
        contents = readPrivateFile(file);
    } catch {
        // A present but unreadable or unsafe gate file must never open reads.
        return { payload: invalidLockedPayload(), authentic: false };
    }
    return contents === undefined
        ? undefined
        : (parsedGateFile(contents, registered.key) ?? { payload: invalidLockedPayload(), authentic: false });
}

function invalidLockedPayload(): GatePayload {
    return { mode: 'paranoid', salt: '', verifier: '', epoch: 1, state: 'locked' };
}

export function memoryServeState(db: Database.Database): GateServeState {
    const stored = readRegisteredState(db);
    if (stored === undefined) {
        return 'unlocked';
    }
    if (!stored.authentic) {
        return 'locked';
    }
    return stored.payload.mode === 'paranoid' ? stored.payload.state : 'unlocked';
}

export function isMemoryLocked(db: Database.Database): boolean {
    return memoryServeState(db) === 'locked';
}

function registeredStateForMutation(db: Database.Database): { registered: RegisteredDatabase; stored?: ParsedGateState } {
    const registered = registeredDatabases.get(db);
    if (registered === undefined) {
        throw new Error('Paranoid mode requires a managed encrypted elepha database.');
    }
    const stored = readRegisteredState(db);
    if (stored !== undefined && !stored.authentic) {
        throw new Error('Paranoid gate state failed authentication. Memory remains locked.');
    }
    return { registered, stored };
}

function verifier(passphrase: string, salt: Buffer): Buffer {
    return scryptSync(passphrase, salt, PARANOID_SCRYPT_OUTPUT_BYTES, {
        N: PARANOID_SCRYPT_N,
        r: PARANOID_SCRYPT_R,
        p: PARANOID_SCRYPT_P,
        maxmem: PARANOID_SCRYPT_MAXMEM_BYTES,
    });
}

function writeState(registered: RegisteredDatabase, payload: GatePayload): void {
    const file: GateFile = { ...payload, hmac: encodedSignature(payload, registered.key) };
    writePrivateFileAtomic(paranoidStatePath(registered.databasePath), Buffer.from(`${JSON.stringify(file)}\n`, 'utf8'), true);
}

function nextEpoch(stored: ParsedGateState | undefined): number {
    return (stored?.payload.epoch ?? 0) + 1;
}

export function enableParanoidMode(db: Database.Database, passphrase: string): void {
    const { registered, stored } = registeredStateForMutation(db);
    if (stored?.payload.mode === 'paranoid') {
        throw new Error('Paranoid mode is already enabled.');
    }
    const salt = randomBytes(PARANOID_SCRYPT_SALT_BYTES);
    const derived = verifier(passphrase, salt);
    try {
        writeState(registered, {
            mode: 'paranoid',
            salt: salt.toString('base64'),
            verifier: derived.toString('base64'),
            epoch: nextEpoch(stored),
            state: 'locked',
        });
    } finally {
        salt.fill(0);
        derived.fill(0);
    }
}

function verifyPassphrase(stored: ParsedGateState, passphrase: string): boolean {
    const salt = Buffer.from(stored.payload.salt, 'base64');
    const expected = Buffer.from(stored.payload.verifier, 'base64');
    const derived = verifier(passphrase, salt);
    try {
        return timingSafeEqual(derived, expected);
    } finally {
        salt.fill(0);
        expected.fill(0);
        derived.fill(0);
    }
}

export function unlockMemory(db: Database.Database, passphrase: string): 'unlocked' | 'incorrect' | 'not_enabled' {
    const { registered, stored } = registeredStateForMutation(db);
    if (stored === undefined || stored.payload.mode !== 'paranoid') {
        return 'not_enabled';
    }
    if (!verifyPassphrase(stored, passphrase)) {
        return 'incorrect';
    }
    writeState(registered, { ...stored.payload, epoch: nextEpoch(stored), state: 'unlocked' });
    return 'unlocked';
}

export function lockMemory(db: Database.Database): 'locked' | 'not_enabled' {
    const { registered, stored } = registeredStateForMutation(db);
    if (stored === undefined || stored.payload.mode !== 'paranoid') {
        return 'not_enabled';
    }
    writeState(registered, { ...stored.payload, epoch: nextEpoch(stored), state: 'locked' });
    return 'locked';
}

export function disableParanoidMode(db: Database.Database, passphrase: string): 'disabled' | 'incorrect' | 'not_enabled' {
    const { registered, stored } = registeredStateForMutation(db);
    if (stored === undefined || stored.payload.mode !== 'paranoid') {
        return 'not_enabled';
    }
    if (!verifyPassphrase(stored, passphrase)) {
        return 'incorrect';
    }
    writeState(registered, { ...stored.payload, mode: 'default', epoch: nextEpoch(stored), state: 'unlocked' });
    return 'disabled';
}
