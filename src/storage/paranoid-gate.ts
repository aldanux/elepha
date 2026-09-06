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
    credentialTag: string;
}

interface ParanoidAuthority {
    enrolled: 0 | 1;
    state: GateServeState;
    generation: number;
    credentialTag: string | null;
}

export interface ParanoidControlState {
    enrolled: 0 | 1;
    state: 'locked' | 'unlocked';
    generation: number;
    credential_tag: string | null;
}

const READ_GENERATION = Symbol('read-generation');

// Generation rejects lock/unlock ABA; enrollment and credential identity reject
// a different authority installed at the same generation.
export interface AuthenticatedReadGeneration {
    readonly [READ_GENERATION]: {
        db: Database.Database;
        enrolled: 0 | 1;
        generation: number;
        credentialTag: string | null;
        registered: boolean;
    };
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

// Commit the stable credential identity without storing salt, verifier, passphrase,
// or key bytes in database authority.
function credentialTag(payload: GatePayload, key: Buffer): string {
    return createHmac('sha256', key)
        .update('elepha-paranoid-credential\0')
        .update(payload.salt)
        .update('\0')
        .update(payload.verifier)
        .digest('base64');
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
    return {
        payload,
        authentic: timingSafeEqual(storedHmac, expectedHmac),
        credentialTag: credentialTag(payload, key),
    };
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
        return { payload: invalidLockedPayload(), authentic: false, credentialTag: '' };
    }
    return contents === undefined
        ? undefined
        : (parsedGateFile(contents, registered.key) ?? { payload: invalidLockedPayload(), authentic: false, credentialTag: '' });
}

function invalidLockedPayload(): GatePayload {
    return { mode: 'paranoid', salt: '', verifier: '', epoch: 1, state: 'locked' };
}

function readAuthority(db: Database.Database): ParanoidAuthority | undefined {
    let row: unknown;
    try {
        row = db.prepare('SELECT enrolled, state, generation, credential_tag FROM paranoid_authority WHERE id = 1').get();
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
        !('credential_tag' in row) ||
        (row.credential_tag !== null &&
            (typeof row.credential_tag !== 'string' || decodedBytes(row.credential_tag, PARANOID_HMAC_BYTES) === undefined)) ||
        (row.enrolled === 0 && row.state !== 'unlocked')
    ) {
        return undefined;
    }
    return { enrolled: row.enrolled, state: row.state, generation: row.generation, credentialTag: row.credential_tag };
}

function pristineAuthority(authority: ParanoidAuthority): boolean {
    return authority.enrolled === 0 && authority.state === 'unlocked' && authority.generation === 0 && authority.credentialTag === null;
}

function authorityForStored(stored: ParsedGateState): ParanoidAuthority {
    const { payload } = stored;
    const enrolled = payload.mode === 'paranoid' ? 1 : 0;
    return {
        enrolled,
        state: enrolled === 1 ? payload.state : 'unlocked',
        generation: payload.epoch,
        credentialTag: stored.credentialTag,
    };
}

function authorityFieldsMatch(authority: ParanoidAuthority, stored: ParsedGateState): boolean {
    const external = authorityForStored(stored);
    return (
        stored.authentic &&
        external.enrolled === authority.enrolled &&
        external.state === authority.state &&
        external.generation === authority.generation
    );
}

function authorityMatches(authority: ParanoidAuthority, stored: ParsedGateState): boolean {
    return authorityFieldsMatch(authority, stored) && authority.credentialTag === stored.credentialTag;
}

// Call outside a SQLite transaction because authentication reads the external gate file.
export function readParanoidControlState(db: Database.Database): ParanoidControlState {
    if (registeredDatabases.get(db) === undefined) {
        throw new Error('Paranoid control state requires a registered encrypted database.');
    }
    const authority = readAuthority(db);
    const stored = readRegisteredState(db);
    if (
        authority === undefined ||
        (pristineAuthority(authority) ? stored !== undefined : stored === undefined || !authorityMatches(authority, stored))
    ) {
        throw new Error('Paranoid control state is invalid or does not match its authenticated gate.');
    }
    return {
        enrolled: authority.enrolled,
        state: authority.state,
        generation: authority.generation,
        credential_tag: authority.credentialTag,
    };
}

export function initializeParanoidAuthority(db: Database.Database): void {
    if (registeredDatabases.get(db) === undefined) {
        return;
    }
    const authority = readAuthority(db);
    if (authority === undefined) {
        return;
    }
    const stored = readRegisteredState(db);
    if (!pristineAuthority(authority)) {
        if (authority.credentialTag === null && stored?.authentic === true && authorityFieldsMatch(authority, stored)) {
            db.prepare(
                `UPDATE paranoid_authority SET credential_tag = ?
                 WHERE id = 1 AND enrolled = ? AND state = ? AND generation = ? AND credential_tag IS NULL`,
            ).run(stored.credentialTag, authority.enrolled, authority.state, authority.generation);
        }
        return;
    }
    if (stored === undefined) {
        return;
    }
    // An invalid legacy anchor cannot prove its old state or generation. Mark
    // the installation enrolled and locked without copying any untrusted field
    // so deleting that anchor later cannot recreate a never-enabled default.
    const adopted: ParanoidAuthority = stored.authentic
        ? authorityForStored(stored)
        : { enrolled: 1, state: 'locked', generation: 0, credentialTag: null };
    const adoptOrQuarantine = db.transaction(() => {
        const current = readAuthority(db);
        if (current === undefined || !pristineAuthority(current)) {
            return;
        }
        db.prepare('UPDATE paranoid_authority SET enrolled = ?, state = ?, generation = ?, credential_tag = ? WHERE id = 1').run(
            adopted.enrolled,
            adopted.state,
            adopted.generation,
            adopted.credentialTag,
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

function authenticatedReadGeneration(db: Database.Database): AuthenticatedReadGeneration | undefined {
    const registered = registeredDatabases.get(db);
    if (registered === undefined) {
        return { [READ_GENERATION]: { db, enrolled: 0, generation: 0, credentialTag: null, registered: false } };
    }
    const authority = readAuthority(db);
    if (authority === undefined) {
        return undefined;
    }
    const stored = readRegisteredState(db);
    const unlocked =
        (pristineAuthority(authority) && stored === undefined) ||
        (stored !== undefined && authorityMatches(authority, stored) && authority.state === 'unlocked');
    if (!unlocked) {
        return undefined;
    }
    return {
        [READ_GENERATION]: {
            db,
            enrolled: authority.enrolled,
            generation: authority.generation,
            credentialTag: authority.credentialTag,
            registered: true,
        },
    };
}

function readGenerationIsCurrent(db: Database.Database, token: AuthenticatedReadGeneration): boolean {
    const expected = token[READ_GENERATION];
    const current = authenticatedReadGeneration(db)?.[READ_GENERATION];
    return (
        expected.db === db &&
        current !== undefined &&
        current.registered === expected.registered &&
        current.enrolled === expected.enrolled &&
        current.generation === expected.generation &&
        current.credentialTag === expected.credentialTag
    );
}

// This is the DB-only half of generation validation for a caller that already
// authenticated the full DB/file state immediately before acquiring a SQLite
// writer slot. Call it only as the first action inside that writer transaction.
export function memoryReadAuthorityMatchesGenerationInTransaction(db: Database.Database, token: AuthenticatedReadGeneration): boolean {
    const expected = token[READ_GENERATION];
    if (expected.db !== db || (registeredDatabases.get(db) !== undefined) !== expected.registered) {
        return false;
    }
    const authority = readAuthority(db);
    return (
        authority !== undefined &&
        authority.enrolled === expected.enrolled &&
        authority.state === 'unlocked' &&
        authority.generation === expected.generation &&
        authority.credentialTag === expected.credentialTag
    );
}

export function withMemoryReadGeneration<T>(
    db: Database.Database,
    locked: () => T,
    read: (token: AuthenticatedReadGeneration) => T,
    existing?: AuthenticatedReadGeneration,
): T {
    const token = existing === undefined ? authenticatedReadGeneration(db) : readGenerationIsCurrent(db, existing) ? existing : undefined;
    if (token === undefined) {
        return locked();
    }
    const result = read(token);
    return readGenerationIsCurrent(db, token) ? result : locked();
}

export async function withMemoryReadGenerationAsync<T>(
    db: Database.Database,
    locked: () => T,
    read: (token: AuthenticatedReadGeneration) => Promise<T>,
    existing?: AuthenticatedReadGeneration,
): Promise<T> {
    const token = existing === undefined ? authenticatedReadGeneration(db) : readGenerationIsCurrent(db, existing) ? existing : undefined;
    if (token === undefined) {
        return locked();
    }
    const result = await read(token);
    return readGenerationIsCurrent(db, token) ? result : locked();
}

function registeredStateForMutation(
    db: Database.Database,
    recover?: 'restrictive_lock' | 'permissive_unlock' | 'permissive_disable',
): {
    registered: RegisteredDatabase;
    authority: ParanoidAuthority;
    stored?: ParsedGateState;
    agreement: 'exact' | 'restrictive_lock_pending' | 'permissive_pending';
} {
    const registered = registeredDatabases.get(db);
    if (registered === undefined) {
        throw new Error('Paranoid mode requires a managed encrypted elepha database.');
    }
    const authority = readAuthority(db);
    const stored = readRegisteredState(db);
    const validPristineState = authority !== undefined && pristineAuthority(authority) && stored === undefined;
    if (authority !== undefined && (validPristineState || (stored !== undefined && authorityMatches(authority, stored)))) {
        return { registered, authority, stored, agreement: 'exact' };
    }
    const matchingCredential =
        authority !== undefined &&
        authority.credentialTag !== null &&
        stored?.authentic === true &&
        stored.credentialTag === authority.credentialTag;
    if (
        matchingCredential &&
        recover === 'restrictive_lock' &&
        authority.enrolled === 1 &&
        authority.state === 'locked' &&
        stored.payload.mode === 'paranoid' &&
        authority.generation === stored.payload.epoch + 1
    ) {
        return { registered, authority, stored, agreement: 'restrictive_lock_pending' };
    }
    const permissiveMode = recover === 'permissive_unlock' ? 'paranoid' : recover === 'permissive_disable' ? 'default' : undefined;
    if (
        matchingCredential &&
        permissiveMode !== undefined &&
        authority.enrolled === 1 &&
        stored.payload.mode === permissiveMode &&
        stored.payload.state === 'unlocked' &&
        stored.payload.epoch === authority.generation + 1
    ) {
        return { registered, authority, stored, agreement: 'permissive_pending' };
    }
    throw new Error('Paranoid gate state failed authentication. Memory remains locked.');
}

function verifier(passphrase: string, salt: Buffer): Buffer {
    return scryptSync(passphrase, salt, PARANOID_SCRYPT_OUTPUT_BYTES, {
        N: PARANOID_SCRYPT_N,
        r: PARANOID_SCRYPT_R,
        p: PARANOID_SCRYPT_P,
        maxmem: PARANOID_SCRYPT_MAXMEM_BYTES,
    });
}

function writeExternalState(registered: RegisteredDatabase, payload: GatePayload): void {
    const file: GateFile = { ...payload, hmac: encodedSignature(payload, registered.key) };
    writePrivateFileAtomic(paranoidStatePath(registered.databasePath), Buffer.from(`${JSON.stringify(file)}\n`, 'utf8'), true);
}

function updateAuthority(db: Database.Database, registered: RegisteredDatabase, previous: ParanoidAuthority, payload: GatePayload): void {
    const next: ParanoidAuthority = {
        enrolled: payload.mode === 'paranoid' ? 1 : 0,
        state: payload.mode === 'paranoid' ? payload.state : 'unlocked',
        generation: payload.epoch,
        credentialTag: credentialTag(payload, registered.key),
    };
    const update = db.transaction(() => {
        const result = db
            .prepare(
                `UPDATE paranoid_authority
                 SET enrolled = ?, state = ?, generation = ?, credential_tag = ?
                 WHERE id = 1 AND enrolled = ? AND state = ? AND generation = ? AND credential_tag IS ?`,
            )
            .run(
                next.enrolled,
                next.state,
                next.generation,
                next.credentialTag,
                previous.enrolled,
                previous.state,
                previous.generation,
                previous.credentialTag,
            );
        if (result.changes !== 1) {
            throw new Error('Paranoid database authority changed during update. Memory remains locked.');
        }
    });
    update();
}

function writeRestrictiveState(
    db: Database.Database,
    registered: RegisteredDatabase,
    previous: ParanoidAuthority,
    payload: GatePayload,
): void {
    updateAuthority(db, registered, previous, payload);
    writeExternalState(registered, payload);
}

function writePermissiveState(
    db: Database.Database,
    registered: RegisteredDatabase,
    previous: ParanoidAuthority,
    payload: GatePayload,
): void {
    writeExternalState(registered, payload);
    updateAuthority(db, registered, previous, payload);
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
        writeRestrictiveState(db, registered, authority, {
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
    const { registered, authority, stored, agreement } = registeredStateForMutation(db, 'permissive_unlock');
    if (authority.enrolled === 0 || stored === undefined || stored.payload.mode !== 'paranoid') {
        return 'not_enabled';
    }
    if (!verifyPassphrase(stored, passphrase)) {
        return 'incorrect';
    }
    if (agreement === 'permissive_pending') {
        updateAuthority(db, registered, authority, stored.payload);
        return 'unlocked';
    }
    writePermissiveState(db, registered, authority, { ...stored.payload, epoch: nextGeneration(authority), state: 'unlocked' });
    return 'unlocked';
}

export function lockMemory(db: Database.Database): 'locked' | 'not_enabled' {
    const { registered, authority, stored, agreement } = registeredStateForMutation(db, 'restrictive_lock');
    if (authority.enrolled === 0 || stored === undefined || stored.payload.mode !== 'paranoid') {
        return 'not_enabled';
    }
    if (agreement === 'restrictive_lock_pending') {
        writeExternalState(registered, { ...stored.payload, epoch: authority.generation, state: 'locked' });
        return 'locked';
    }
    writeRestrictiveState(db, registered, authority, { ...stored.payload, epoch: nextGeneration(authority), state: 'locked' });
    return 'locked';
}

export function disableParanoidMode(db: Database.Database, passphrase: string): 'disabled' | 'incorrect' | 'not_enabled' {
    const { registered, authority, stored, agreement } = registeredStateForMutation(db, 'permissive_disable');
    if (authority.enrolled === 0 || stored === undefined || (stored.payload.mode !== 'paranoid' && agreement !== 'permissive_pending')) {
        return 'not_enabled';
    }
    if (!verifyPassphrase(stored, passphrase)) {
        return 'incorrect';
    }
    if (agreement === 'permissive_pending') {
        updateAuthority(db, registered, authority, stored.payload);
        return 'disabled';
    }
    writePermissiveState(db, registered, authority, {
        ...stored.payload,
        mode: 'default',
        epoch: nextGeneration(authority),
        state: 'unlocked',
    });
    return 'disabled';
}
