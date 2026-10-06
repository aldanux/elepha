// Onboarding commits to two stores that cannot share one transaction:
// config.json and consent rows in SQLite. This journal records one confirmed
// apply while it crosses between them. It lives beside config.json, never in
// the database, so a database backup or restore cannot carry onboarding intent
// into another installation or replay it later. It is published with a hard
// link, so exactly one process can own it, and it names its owner's pid so an
// apply still running is never mistaken for an interrupted one.

import { randomUUID } from 'node:crypto';
import {
    closeSync,
    fchmodSync,
    constants as fsConstants,
    fstatSync,
    fsyncSync,
    linkSync,
    lstatSync,
    mkdirSync,
    openSync,
    readFileSync,
    unlinkSync,
    writeFileSync,
} from 'node:fs';
import path from 'node:path';
import type { ConsentRoot, ConsentState } from '../storage/consent-store.js';
import { removeFileIfExists } from '../util/fs.js';
import { PRIVATE_DIR_MODE, PRIVATE_FILE_MODE } from './constants.js';
import { samePath } from './paths.js';

// Onboarding writes only these keys; a journal naming any other key is refused.
export const INIT_SETTING_KEYS = ['capture-claude-code', 'capture-codex', 'capture-opencode', 'memory-plus'] as const;
export type InitSettingKey = (typeof INIT_SETTING_KEYS)[number];

// A plan touches one row per shown root. Far above any real workspace, and
// small enough that reading and checking a journal stays trivially cheap.
export const INIT_APPLY_MAX_ROOTS = 1_000;
export const INIT_APPLY_JOURNAL_MAX_BYTES = 1_048_576;
// Longest accepted root path; PATH_MAX on Linux and well above macOS's.
const MAX_ROOT_PATH_LENGTH = 4_096;

export interface InitApplySetting {
    // The typed value config.json held before the apply; null when absent.
    previous: boolean | null;
    target: boolean;
}

export interface InitApplyConsent {
    root: string;
    previous: ConsentRoot | null;
    target: 'approved' | 'denied';
    // `dev:ino` of the physical directory confirmed in the preview; null when
    // the path did not resolve to an existing directory then.
    identity: string | null;
}

export interface InitApplyJournal {
    version: 1;
    operationId: string;
    pid: number;
    startedAt: string;
    configPath: string;
    settings: Partial<Record<InitSettingKey, InitApplySetting>>;
    consent: InitApplyConsent[];
    // Newly approved roots whose post-commit backfill has not run yet.
    backfillRoots: string[];
}

export interface HeldInitApplyJournal {
    file: string;
    dev: number;
    ino: number;
    journal: InitApplyJournal;
}

export class InitApplyBusyError extends Error {
    constructor(readonly file: string) {
        super(`Another elepha setup owns ${file}; nothing was changed.`);
        this.name = 'InitApplyBusyError';
    }
}

export const INIT_APPLY_PENDING_ERROR =
    'An elepha init is applying choices or was interrupted. Run elepha init to finish it first; nothing was changed.';

export function initApplyJournalPath(configPath: string): string {
    return path.join(path.dirname(path.resolve(configPath)), 'init-apply.json');
}

// Config and consent writers outside onboarding refuse while a journal exists:
// resolving it compares current state with the journal, and a decision taken
// in between would otherwise read as a conflict or be reverted.
export function assertNoPendingInitApply(configPath: string): void {
    try {
        lstatSync(initApplyJournalPath(configPath));
    } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return;
        }
        throw error;
    }
    throw new Error(INIT_APPLY_PENDING_ERROR);
}

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const FILE_IDENTITY = /^\d{1,20}:\d{1,20}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CONSENT_STATES: readonly ConsentState[] = ['approved', 'denied', 'pending'];
const CONSENT_SOURCES: readonly ConsentRoot['source'][] = ['discovery', 'cli', 'grandfathered'];

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
    return Object.keys(value).every((key) => keys.includes(key));
}

function isAbsoluteRoot(value: unknown): value is string {
    return (
        typeof value === 'string' &&
        value.length > 0 &&
        value.length <= MAX_ROOT_PATH_LENGTH &&
        !value.includes('\0') &&
        path.isAbsolute(value) &&
        path.resolve(value) === value
    );
}

function isTimestamp(value: unknown): value is string {
    return typeof value === 'string' && value.length <= 64 && !Number.isNaN(Date.parse(value));
}

function isConsentRow(value: unknown, root: string): value is ConsentRoot {
    return (
        isRecord(value) &&
        hasOnlyKeys(value, ['ulid', 'path', 'state', 'decided_at', 'source']) &&
        typeof value.ulid === 'string' &&
        ULID.test(value.ulid) &&
        isAbsoluteRoot(value.path) &&
        samePath(value.path, root) &&
        CONSENT_STATES.includes(value.state as ConsentState) &&
        isTimestamp(value.decided_at) &&
        CONSENT_SOURCES.includes(value.source as ConsentRoot['source'])
    );
}

function isSetting(value: unknown): value is InitApplySetting {
    return (
        isRecord(value) &&
        hasOnlyKeys(value, ['previous', 'target']) &&
        (value.previous === null || typeof value.previous === 'boolean') &&
        typeof value.target === 'boolean'
    );
}

function validJournal(value: unknown): value is InitApplyJournal {
    if (
        !isRecord(value) ||
        !hasOnlyKeys(value, ['version', 'operationId', 'pid', 'startedAt', 'configPath', 'settings', 'consent', 'backfillRoots']) ||
        value.version !== 1 ||
        typeof value.operationId !== 'string' ||
        !UUID.test(value.operationId) ||
        typeof value.pid !== 'number' ||
        !Number.isInteger(value.pid) ||
        value.pid <= 0 ||
        !isTimestamp(value.startedAt) ||
        !isAbsoluteRoot(value.configPath) ||
        !isRecord(value.settings) ||
        !Array.isArray(value.consent) ||
        !Array.isArray(value.backfillRoots)
    ) {
        return false;
    }
    const settings = value.settings;
    if (!hasOnlyKeys(settings, INIT_SETTING_KEYS) || !Object.values(settings).every(isSetting)) {
        return false;
    }
    const consent = value.consent as unknown[];
    if (consent.length > INIT_APPLY_MAX_ROOTS) {
        return false;
    }
    const roots: string[] = [];
    for (const entry of consent) {
        if (
            !isRecord(entry) ||
            !hasOnlyKeys(entry, ['root', 'previous', 'target', 'identity']) ||
            !isAbsoluteRoot(entry.root) ||
            (entry.identity !== null && (typeof entry.identity !== 'string' || !FILE_IDENTITY.test(entry.identity))) ||
            (entry.target !== 'approved' && entry.target !== 'denied') ||
            (entry.previous !== null && !isConsentRow(entry.previous, entry.root)) ||
            roots.some((root) => samePath(root, entry.root as string))
        ) {
            return false;
        }
        roots.push(entry.root);
    }
    const approved = (consent as InitApplyConsent[]).filter((entry) => entry.target === 'approved').map((entry) => entry.root);
    return (
        value.backfillRoots.length <= approved.length &&
        value.backfillRoots.every((root) => typeof root === 'string' && approved.includes(root))
    );
}

export function newInitApplyJournal(
    configPath: string,
    settings: InitApplyJournal['settings'],
    consent: InitApplyConsent[],
    backfillRoots: string[],
): InitApplyJournal {
    return {
        version: 1,
        operationId: randomUUID(),
        pid: process.pid,
        startedAt: new Date().toISOString(),
        configPath: path.resolve(configPath),
        settings,
        consent,
        backfillRoots,
    };
}

// Reads the journal through the opened object: a symlink, a non-regular file,
// another user's file, a group/world-accessible file, an oversized file or an
// invalid shape is an error, never "nothing pending" and never an instruction.
export function readInitApplyJournal(configPath: string): HeldInitApplyJournal | undefined {
    const file = initApplyJournalPath(configPath);
    let descriptor: number;
    try {
        descriptor = openSync(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return undefined;
        }
        throw new Error(`Cannot read the interrupted elepha setup record ${file}: ${(error as Error).message}`);
    }
    try {
        const opened = fstatSync(descriptor);
        const ownedByUser = process.getuid === undefined || opened.uid === process.getuid();
        if (!opened.isFile() || !ownedByUser || (opened.mode & 0o077) !== 0 || opened.size > INIT_APPLY_JOURNAL_MAX_BYTES) {
            throw new Error(`The interrupted elepha setup record ${file} is not a private regular file of this user; refusing to use it.`);
        }
        let parsed: unknown;
        try {
            parsed = JSON.parse(readFileSync(descriptor, 'utf8'));
        } catch {
            parsed = undefined;
        }
        if (!validJournal(parsed) || parsed?.configPath !== path.resolve(configPath)) {
            throw new Error(
                `The interrupted elepha setup record ${file} is invalid or belongs to another configuration; refusing to guess its state.`,
            );
        }
        return { file, dev: opened.dev, ino: opened.ino, journal: parsed };
    } finally {
        closeSync(descriptor);
    }
}

// Publishes a fully written journal without replacing an existing one: the
// hard link fails with EEXIST when another apply already owns the path.
export function publishInitApplyJournal(journal: InitApplyJournal): HeldInitApplyJournal {
    const file = initApplyJournalPath(journal.configPath);
    const directory = path.dirname(file);
    mkdirSync(directory, { recursive: true, mode: PRIVATE_DIR_MODE });
    const candidate = path.join(directory, `.init-apply.${process.pid}.${randomUUID()}.candidate`);
    let descriptor: number | undefined;
    try {
        descriptor = openSync(
            candidate,
            fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0),
            PRIVATE_FILE_MODE,
        );
        fchmodSync(descriptor, PRIVATE_FILE_MODE);
        writeFileSync(descriptor, `${JSON.stringify(journal)}\n`);
        fsyncSync(descriptor);
        const identity = fstatSync(descriptor);
        closeSync(descriptor);
        descriptor = undefined;
        try {
            linkSync(candidate, file);
        } catch (error: unknown) {
            if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
                throw new InitApplyBusyError(file);
            }
            throw error;
        }
        return { file, dev: identity.dev, ino: identity.ino, journal };
    } finally {
        if (descriptor !== undefined) {
            closeSync(descriptor);
        }
        removeFileIfExists(candidate);
    }
}

// Removes the journal only if it is still the exact file this process holds.
export function releaseInitApplyJournal(held: Pick<HeldInitApplyJournal, 'file' | 'dev' | 'ino'>): void {
    try {
        const current = lstatSync(held.file);
        if (current.isFile() && current.dev === held.dev && current.ino === held.ino) {
            unlinkSync(held.file);
        }
    } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            throw error;
        }
    }
}

export function initApplyOwnerIsLive(journal: InitApplyJournal): boolean {
    if (journal.pid === process.pid) {
        return false;
    }
    try {
        process.kill(journal.pid, 0);
        return true;
    } catch (error: unknown) {
        return (error as NodeJS.ErrnoException).code === 'EPERM';
    }
}
