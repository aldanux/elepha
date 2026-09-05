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

interface ParanoidAuthority {
    enrolled: 0 | 1;
    state: GateServeState;
    generation: number;
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

function readAuthority(db: Database.Database): ParanoidAuthority | undefined {
    let row: unknown;
    try {
        row = db.prepare('SELECT enrolled, state, generation FROM paranoid_authority WHERE id = 1').get();
    } catch {
        return undefined;
    }
    if (
        !row ||
        typeof row !== 'object' ||
        !('enrolled' in row) ||
        (row.enrolled !== 0 && row.enrolled !== 1) ||
        !('state' in row) ||
        (row.state !== 'locked' && row.state !== 'unlocked') ||
        !('generation' in row) ||
        typeof row.generation !== 'number' ||
        !Number.isSafeInteger(row.generation) ||
        row.generation < 0 ||
        (row.enrolled === 0 && row.state !== 'unlocked')
    ) {
        return undefined;
    }
    return { enrolled: row.enrolled, state: row.state, generation: row.generation };
}

function pristineAuthority(authority: ParanoidAuthority): boolean {
    return authority.enrolled === 0 && authority.state === 'unlocked' && authority.generation === 0;
}

function authorityForPayload(payload: GatePayload): ParanoidAuthority {
    const enrolled = payload.mode === 'paranoid' ? 1 : 0;
    return {
        enrolled,
        state: enrolled === 1 ? payload.state : 'unlocked',
        generation: payload.epoch,
    };
}

function authorityMatches(authority: ParanoidAuthority, stored: ParsedGateState): boolean {
    const external = authorityForPayload(stored.payload);
    return (
        stored.authentic &&
        external.enrolled === authority.enrolled &&
        external.state === authority.state &&
        external.generation === authority.generation
    );
}

export function initializeParanoidAuthority(db: Database.Database): void {
    if (registeredDatabases.get(db) === undefined) {
        return;
    }
    const authority = readAuthority(db);
    if (authority === undefined || !pristineAuthority(authority)) {
        return;
    }
    const stored = readRegisteredState(db);
    if (stored === undefined) {
        return;
    }
    // An invalid legacy anchor cannot prove its old state or generation. Mark
    // the installation enrolled and locked without copying any untrusted field
    // so deleting that anchor later cannot recreate a never-enabled default.
    const adopted: ParanoidAuthority = stored.authentic
        ? authorityForPayload(stored.payload)
        : { enrolled: 1, state: 'locked', generation: 0 };
    const adoptOrQuarantine = db.transaction(() => {
        const current = readAuthority(db);
        if (current === undefined || !pristineAuthority(current)) {
            return;
        }
        db.prepare('UPDATE paranoid_authority SET enrolled = ?, state = ?, generation = ? WHERE id = 1').run(
            adopted.enrolled,
            adopted.state,
            adopted.generation,
        );
    });
    adoptOrQuarantine();
}

export function memoryServeState(db: Database.Database): GateServeState {
    if (registeredDatabases.get(db) === undefined) {
        return 'unlocked';
    }
    const authority = readAuthority(db);
    if (authority === undefined) {
        return 'locked';
    }
    const stored = readRegisteredState(db);
    if (pristineAuthority(authority) && stored === undefined) {
        return 'unlocked';
    }
    if (stored === undefined || !authorityMatches(authority, stored)) {
        return 'locked';
    }
    return authority.state;
}

export function isMemoryLocked(db: Database.Database): boolean {
    return memoryServeState(db) === 'locked';
}

function registeredStateForMutation(db: Database.Database): {
    registered: RegisteredDatabase;
    authority: ParanoidAuthority;
    stored?: ParsedGateState;
} {
    const registered = registeredDatabases.get(db);
    if (registered === undefined) {
        throw new Error('Paranoid mode requires a managed encrypted elepha database.');
    }
    const authority = readAuthority(db);
    const stored = readRegisteredState(db);
    const validPristineState = authority !== undefined && pristineAuthority(authority) && stored === undefined;
    if (authority === undefined || (!validPristineState && (stored === undefined || !authorityMatches(authority, stored)))) {
        throw new Error('Paranoid gate state failed authentication. Memory remains locked.');
    }
    return { registered, authority, stored };
}

function verifier(passphrase: string, salt: Buffer): Buffer {
    return scryptSync(passphrase, salt, PARANOID_SCRYPT_OUTPUT_BYTES, {
        N: PARANOID_SCRYPT_N,
        r: PARANOID_SCRYPT_R,
        p: PARANOID_SCRYPT_P,
        maxmem: PARANOID_SCRYPT_MAXMEM_BYTES,
    });
}

function writeState(db: Database.Database, registered: RegisteredDatabase, previous: ParanoidAuthority, payload: GatePayload): void {
    const file: GateFile = { ...payload, hmac: encodedSignature(payload, registered.key) };
    writePrivateFileAtomic(paranoidStatePath(registered.databasePath), Buffer.from(`${JSON.stringify(file)}\n`, 'utf8'), true);
    const next = authorityForPayload(payload);
    const update = db.transaction(() => {
        const result = db
            .prepare(
                `UPDATE paranoid_authority
                 SET enrolled = ?, state = ?, generation = ?
                 WHERE id = 1 AND enrolled = ? AND state = ? AND generation = ?`,
            )
            .run(next.enrolled, next.state, next.generation, previous.enrolled, previous.state, previous.generation);
        if (result.changes !== 1) {
            throw new Error('Paranoid database authority changed during update. Memory remains locked.');
        }
    });
    update();
}

function nextGeneration(authority: ParanoidAuthority): number {
    const next = authority.generation + 1;
    if (!Number.isSafeInteger(next)) {
        throw new Error('Paranoid gate generation is exhausted. Memory remains locked.');
    }
    return next;
}

export function enableParanoidMode(db: Database.Database, passphrase: string): void {
    const { registered, authority } = registeredStateForMutation(db);
    if (authority.enrolled === 1) {
        throw new Error('Paranoid mode is already enabled.');
    }
    const salt = randomBytes(PARANOID_SCRYPT_SALT_BYTES);
    const derived = verifier(passphrase, salt);
    try {
        writeState(db, registered, authority, {
            mode: 'paranoid',
            salt: salt.toString('base64'),
            verifier: derived.toString('base64'),
            epoch: nextGeneration(authority),
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
    const { registered, authority, stored } = registeredStateForMutation(db);
    if (authority.enrolled === 0 || stored === undefined || stored.payload.mode !== 'paranoid') {
        return 'not_enabled';
    }
    if (!verifyPassphrase(stored, passphrase)) {
        return 'incorrect';
    }
    writeState(db, registered, authority, { ...stored.payload, epoch: nextGeneration(authority), state: 'unlocked' });
    return 'unlocked';
}

export function lockMemory(db: Database.Database): 'locked' | 'not_enabled' {
    const { registered, authority, stored } = registeredStateForMutation(db);
    if (authority.enrolled === 0 || stored === undefined || stored.payload.mode !== 'paranoid') {
        return 'not_enabled';
    }
    writeState(db, registered, authority, { ...stored.payload, epoch: nextGeneration(authority), state: 'locked' });
    return 'locked';
}

export function disableParanoidMode(db: Database.Database, passphrase: string): 'disabled' | 'incorrect' | 'not_enabled' {
    const { registered, authority, stored } = registeredStateForMutation(db);
    if (authority.enrolled === 0 || stored === undefined || stored.payload.mode !== 'paranoid') {
        return 'not_enabled';
    }
    if (!verifyPassphrase(stored, passphrase)) {
        return 'incorrect';
    }
    writeState(db, registered, authority, {
        ...stored.payload,
        mode: 'default',
        epoch: nextGeneration(authority),
        state: 'unlocked',
    });
    return 'disabled';
}
