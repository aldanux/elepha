import {
    closeSync,
    copyFileSync,
    linkSync,
    mkdirSync,
    readFileSync,
    realpathSync,
    renameSync,
    statSync,
    unlinkSync,
    writeFileSync,
} from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import type Database from 'better-sqlite3-multiple-ciphers';
import { afterEach, expect, it, vi } from 'vitest';
import { DATABASE_LIFECYCLE_OPEN_SEAL_ATTEMPTS } from '../../src/config/constants.js';
import { openKeyedDatabase } from '../../src/storage/db.js';
import {
    createPrivateEmptyDatabaseDescriptor,
    inspectDatabaseImportSource,
    inspectPrivateEmptyDatabaseDescriptor,
    writeEncryptedDatabaseImport,
} from '../../src/storage/encrypted-database-export.js';
import { withGrantableTestDir } from '../helpers/tmp.js';

const hook = vi.hoisted(() => ({
    source: '',
    destination: '',
    before: undefined as (() => void) | undefined,
    after: undefined as ((database: Database.Database) => void) | undefined,
    destinationBefore: undefined as (() => void) | undefined,
    destinationAfter: undefined as ((database: Database.Database) => void) | undefined,
    attempts: 0,
    destinationAttempts: 0,
    opened: [] as Array<{ database: Database.Database; calls: string[] }>,
    destinationOpened: [] as Array<{ database: Database.Database; calls: string[] }>,
}));
vi.mock('better-sqlite3-multiple-ciphers', async (original) => {
    const actual = await original<{ default: typeof import('better-sqlite3-multiple-ciphers') }>();
    return {
        ...actual,
        default: new Proxy(actual.default, {
            construct(target, args, newTarget) {
                const filename =
                    (hook.source !== '' || hook.destination !== '') && typeof args[0] === 'string' ? realpathSync(args[0]) : undefined;
                const watched = filename === hook.source;
                // Readonly destination opens perform final ciphertext verification;
                // count only the writable construction proof and its retries here.
                const watchedDestination =
                    filename === hook.destination && (args[1] as ConstructorParameters<typeof Database>[1])?.readonly !== true;
                if (watched) {
                    hook.attempts++;
                    hook.before?.();
                }
                if (watchedDestination) {
                    hook.destinationAttempts++;
                    hook.destinationBefore?.();
                }
                const database = Reflect.construct(target, args, newTarget) as Database.Database;
                if (watched || watchedDestination) {
                    const calls: string[] = [];
                    (watched ? hook.opened : hook.destinationOpened).push({ database, calls });
                    const key = database.key.bind(database);
                    vi.spyOn(database, 'key').mockImplementation((value) => {
                        calls.push('key');
                        return key(value);
                    });
                    const pragma = database.pragma.bind(database);
                    vi.spyOn(database, 'pragma').mockImplementation((sql, options) => {
                        calls.push(sql === 'database_list' ? 'filename' : 'pragma');
                        return pragma(sql, options);
                    });
                    const prepare = database.prepare.bind(database);
                    vi.spyOn(database, 'prepare').mockImplementation((sql) => {
                        calls.push('read');
                        return prepare(sql);
                    });
                    const exec = database.exec.bind(database);
                    vi.spyOn(database, 'exec').mockImplementation((sql) => {
                        calls.push('write');
                        return exec(sql);
                    });
                    vi.spyOn(database, 'transaction');
                    if (watched) hook.after?.(database);
                    else hook.destinationAfter?.(database);
                }
                return database;
            },
        }),
    };
});

afterEach(() => {
    hook.source = '';
    hook.destination = '';
    hook.before = undefined;
    hook.after = undefined;
    hook.destinationBefore = undefined;
    hook.destinationAfter = undefined;
    for (const { database } of [...hook.opened, ...hook.destinationOpened]) if (database.open) database.close();
    hook.opened = [];
    hook.destinationOpened = [];
    hook.attempts = 0;
    hook.destinationAttempts = 0;
    vi.restoreAllMocks();
});

const fixtureKey = Buffer.from(Array.from({ length: 32 }, (_, i) => i + 1));
function fixture() {
    const root = withGrantableTestDir('encrypted-import-open-');
    const sourceParent = path.join(root, 'source', 'nested');
    mkdirSync(sourceParent, { recursive: true });
    const source = path.join(sourceParent, 'original.db');
    const seeded = openKeyedDatabase(source, fixtureKey);
    seeded.exec(`
        CREATE TABLE marker(id INTEGER PRIMARY KEY, body BLOB NOT NULL);
        INSERT INTO marker VALUES(7,X'FF0080');
        CREATE INDEX marker_body ON marker(body);
        CREATE VIEW marker_view AS SELECT id,hex(body) AS body FROM marker;
    `);
    seeded.close();
    const expected = openKeyedDatabase(source, fixtureKey, { readonly: true });
    const schema = expected.prepare('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name').all();
    const rows = expected.prepare('SELECT * FROM marker_view').all();
    expected.close();
    const originalBytes = readFileSync(source);
    const identity = inspectDatabaseImportSource(source).identity;
    const destination = path.join(root, 'stage.db');
    const descriptor = createPrivateEmptyDatabaseDescriptor(destination);
    const destinationIdentity = inspectPrivateEmptyDatabaseDescriptor(descriptor);
    closeSync(descriptor);
    const run = (validate?: (db: Database.Database) => void, sourceKey = fixtureKey) =>
        writeEncryptedDatabaseImport(source, identity, destination, destinationIdentity, fixtureKey, sourceKey, validate);
    const verify = () => {
        expect(readFileSync(source)).toEqual(originalBytes);
        expect(inspectDatabaseImportSource(source).identity).toEqual(identity);
        expect(readFileSync(destination).subarray(0, 16).toString('binary')).not.toBe('SQLite format 3\0');
        hook.source = '';
        hook.destination = '';
        const restored = openKeyedDatabase(destination, fixtureKey, { readonly: true });
        try {
            expect(restored.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }]);
            expect(restored.prepare('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name').all()).toEqual(schema);
            expect(restored.prepare('SELECT * FROM marker_view').all()).toEqual(rows);
        } finally {
            restored.close();
        }
    };
    const churn = () => {
        mkdirSync(path.join(sourceParent, `sibling-${hook.attempts}`));
        mkdirSync(path.join(path.dirname(sourceParent), `sibling-${hook.attempts}`));
    };
    hook.source = source;
    hook.destination = destination;
    return { root, source, sourceParent, destination, destinationIdentity, identity, originalBytes, run, verify, churn };
}

function destinationChurn(f: ReturnType<typeof fixture>): void {
    mkdirSync(path.join(f.root, `destination-sibling-${hook.destinationAttempts}`));
    withGrantableTestDir('encrypted-import-destination-churn-');
}

it.skipIf(process.platform !== 'darwin')(
    'imports after adjacent destination churn during source validation with original authority intact',
    () => {
        const f = fixture();
        const ancestors = [f.root, path.dirname(f.root)];
        const before = ancestors.map((directory) => statSync(directory, { bigint: true }));
        const validate = vi.fn((database: Database.Database) => {
            expect(database.prepare('SELECT * FROM marker_view').all()).toEqual([{ id: 7, body: 'FF0080' }]);
            destinationChurn(f);
            for (const [index, directory] of ancestors.entries()) {
                const after = statSync(directory, { bigint: true });
                expect(after.dev).toBe(before[index]?.dev);
                expect(after.ino).toBe(before[index]?.ino);
                expect(after.ctimeNs).not.toBe(before[index]?.ctimeNs);
            }
            expect(inspectDatabaseImportSource(f.destination).identity).toEqual(f.destinationIdentity);
            expect(readFileSync(f.source)).toEqual(f.originalBytes);
        });
        f.run(validate);
        expect(validate).toHaveBeenCalledOnce();
        expect(hook.attempts).toBe(1);
        expect(hook.destinationAttempts).toBe(1);
        f.verify();
    },
);

function expectNoDestinationCopy(f: ReturnType<typeof fixture>, validate: ReturnType<typeof vi.fn>): void {
    expect(hook.attempts).toBe(1);
    expect(validate).toHaveBeenCalledOnce();
    expect(hook.opened[0]?.database.open).toBe(false);
    expect(hook.opened[0]?.database.transaction).not.toHaveBeenCalled();
    expect(statSync(f.destination).size).toBe(0);
    expect(readFileSync(f.source)).toEqual(f.originalBytes);
    expect(inspectDatabaseImportSource(f.source).identity).toEqual(f.identity);
}

it.skipIf(process.platform !== 'darwin')(
    'retries one-time destination construction churn without repeating source validation or copying',
    () => {
        const f = fixture();
        hook.destinationBefore = () => {
            if (hook.destinationAttempts === 1) destinationChurn(f);
            else expect(hook.destinationOpened[0]?.database.open).toBe(false);
        };
        const validate = vi.fn();
        f.run(validate);
        expect(hook.attempts).toBe(1);
        expect(validate).toHaveBeenCalledOnce();
        expect(hook.destinationAttempts).toBe(2);
        expect(hook.destinationOpened[0]?.database.open).toBe(false);
        expect(hook.destinationOpened[0]?.calls).toEqual([]);
        expect(hook.opened[0]?.database.transaction).toHaveBeenCalledOnce();
        expect(hook.destinationOpened[1]?.database.transaction).toHaveBeenCalledOnce();
        f.verify();
    },
);

it.skipIf(process.platform !== 'darwin')(
    'exhausts destination churn without keying an unverified handle or beginning the copy transaction',
    () => {
        const f = fixture();
        hook.destinationBefore = () => destinationChurn(f);
        const validate = vi.fn();
        expect(() => f.run(validate)).toThrow(`managed database path changed while SQLite opened ${f.destination}`);
        expect(hook.destinationAttempts).toBe(DATABASE_LIFECYCLE_OPEN_SEAL_ATTEMPTS);
        expect(hook.destinationOpened).toHaveLength(DATABASE_LIFECYCLE_OPEN_SEAL_ATTEMPTS);
        for (const { database, calls } of hook.destinationOpened) {
            expect(database.open).toBe(false);
            expect(calls).toEqual([]);
            expect(database.transaction).not.toHaveBeenCalled();
        }
        expectNoDestinationCopy(f, validate);
        expect(inspectDatabaseImportSource(f.destination).identity).toEqual(f.destinationIdentity);
    },
);

it.skipIf(process.platform !== 'darwin')('retains failed destination handle ownership and never retries before proven close', () => {
    const f = fixture();
    hook.destinationBefore = () => destinationChurn(f);
    let closeAttempts = 0;
    hook.destinationAfter = (database) => {
        const close = database.close.bind(database);
        database.close = () => {
            if (++closeAttempts === 1) throw new Error('forced destination handle close failure');
            return close();
        };
    };
    const validate = vi.fn();
    let caught: unknown;
    try {
        f.run(validate);
    } catch (error) {
        caught = error;
    }
    expect(caught).toBeInstanceOf(AggregateError);
    expect((caught as AggregateError).errors.map(String)).toEqual([
        expect.stringContaining(`managed database path changed while SQLite opened ${f.destination}`),
        expect.stringContaining('forced destination handle close failure'),
    ]);
    expect(hook.destinationAttempts).toBe(1);
    const opened = hook.destinationOpened[0];
    expect(opened?.database.open).toBe(true);
    expect(opened?.calls).toEqual([]);
    expect(opened?.database.transaction).not.toHaveBeenCalled();
    expectNoDestinationCopy(f, validate);
    opened?.database.close();
    expect(closeAttempts).toBe(2);
    expect(opened?.database.open).toBe(false);
});

it.skipIf(process.platform !== 'darwin')('reports destination proof cleanup failure without another construction or any copying', () => {
    const f = fixture();
    const mutableFs = createRequire(import.meta.url)('node:fs') as typeof import('node:fs');
    const originalOpen = mutableFs.openSync;
    const originalClose = mutableFs.closeSync;
    const pinnedDestinationDescriptors = new Set<number>();
    let attemptDescriptor: number | undefined;
    let failedDescriptor: number | undefined;
    mutableFs.openSync = (...args) => {
        const descriptor = originalOpen(...args);
        if (args[0] === f.destination) pinnedDestinationDescriptors.add(descriptor);
        return descriptor;
    };
    mutableFs.closeSync = (descriptor) => {
        if (failedDescriptor === undefined && descriptor === attemptDescriptor) {
            failedDescriptor = descriptor;
            throw new Error('forced destination proof descriptor close failure');
        }
        originalClose(descriptor);
        pinnedDestinationDescriptors.delete(descriptor);
    };
    hook.destinationBefore = () => {
        expect(pinnedDestinationDescriptors.size).toBe(2);
        attemptDescriptor = [...pinnedDestinationDescriptors].at(-1);
        destinationChurn(f);
    };
    syncBuiltinESMExports();
    const validate = vi.fn();
    let caught: unknown;
    try {
        f.run(validate);
    } catch (error) {
        caught = error;
    } finally {
        mutableFs.openSync = originalOpen;
        mutableFs.closeSync = originalClose;
        syncBuiltinESMExports();
        if (failedDescriptor !== undefined) originalClose(failedDescriptor);
    }
    expect(failedDescriptor).toBeDefined();
    expect(caught).toBeInstanceOf(AggregateError);
    expect((caught as AggregateError).errors.map(String)).toEqual([
        expect.stringContaining(`managed database path changed while SQLite opened ${f.destination}`),
        expect.stringContaining('forced destination proof descriptor close failure'),
    ]);
    expect(hook.destinationAttempts).toBe(1);
    expect(hook.destinationOpened[0]?.database.open).toBe(false);
    expect(hook.destinationOpened[0]?.calls).toEqual([]);
    expectNoDestinationCopy(f, validate);
});

it.each(['replace', 'replace and restore', 'same-inode write', 'same-inode write and changed preview metadata', 'new hard link'] as const)(
    'rejects destination %s during source validation against the original authority',
    (change) => {
        const f = fixture();
        const parked = path.join(f.root, 'parked-stage.db');
        let substituted: ReturnType<typeof inspectDatabaseImportSource>['identity'] | undefined;
        const validate = vi.fn(() => {
            if (change === 'replace' || change === 'replace and restore') {
                renameSync(f.destination, parked);
                closeSync(createPrivateEmptyDatabaseDescriptor(f.destination));
                substituted = inspectDatabaseImportSource(f.destination).identity;
                if (change === 'replace and restore') {
                    unlinkSync(f.destination);
                    renameSync(parked, f.destination);
                }
            } else if (change === 'same-inode write' || change === 'same-inode write and changed preview metadata') {
                writeFileSync(f.destination, 'unapproved destination bytes');
                if (change === 'same-inode write and changed preview metadata') {
                    Object.assign(f.destinationIdentity, inspectDatabaseImportSource(f.destination).identity);
                }
            } else {
                linkSync(f.destination, parked);
            }
        });
        expect(() => f.run(validate)).toThrow();
        expect(validate).toHaveBeenCalledOnce();
        expect(hook.attempts).toBe(1);
        expect(hook.destinationAttempts).toBe(0);
        expect(hook.destinationOpened).toHaveLength(0);
        expect(hook.opened[0]?.database.transaction).not.toHaveBeenCalled();
        expect(hook.opened[0]?.database.open).toBe(false);
        expect(readFileSync(f.source)).toEqual(f.originalBytes);
        if (change === 'replace') {
            expect(inspectDatabaseImportSource(f.destination).identity).toEqual(substituted);
            expect(statSync(parked).size).toBe(0);
        } else if (change === 'same-inode write' || change === 'same-inode write and changed preview metadata') {
            expect(readFileSync(f.destination, 'utf8')).toBe('unapproved destination bytes');
        } else {
            expect(statSync(f.destination).size).toBe(0);
        }
    },
);

it.each([false, true])('never admits a destination file substituted during construction (restored: %s)', (restore) => {
    const f = fixture();
    const parked = path.join(f.root, 'parked-stage.db');
    hook.destinationBefore = () => {
        renameSync(f.destination, parked);
        copyFileSync(f.source, f.destination);
    };
    hook.destinationAfter = () => {
        if (restore) {
            unlinkSync(f.destination);
            renameSync(parked, f.destination);
        }
    };
    const validate = vi.fn();
    expect(() => f.run(validate)).toThrow();
    expect(validate).toHaveBeenCalledOnce();
    expect(hook.attempts).toBe(1);
    expect(hook.opened[0]?.database.transaction).not.toHaveBeenCalled();
    expect(hook.opened[0]?.database.open).toBe(false);
    expect(hook.destinationAttempts).toBe(1);
    expect(hook.destinationOpened[0]?.calls).toEqual([]);
    expect(hook.destinationOpened[0]?.database.open).toBe(false);
    expect(hook.destinationOpened[0]?.database.transaction).not.toHaveBeenCalled();
    expect(readFileSync(f.source)).toEqual(f.originalBytes);
    if (restore) expect(statSync(f.destination).size).toBe(0);
    else {
        expect(readFileSync(f.destination)).toEqual(f.originalBytes);
        expect(statSync(parked).size).toBe(0);
    }
});

it.skipIf(process.platform !== 'darwin')('imports the exact encrypted schema and rows after one-time adjacent ancestor churn', () => {
    const f = fixture();
    hook.before = () => {
        if (hook.attempts === 1) f.churn();
        else expect(hook.opened[0]?.database.open).toBe(false);
    };
    const validate = vi.fn((db: Database.Database) =>
        expect(db.prepare('SELECT * FROM marker_view').all()).toEqual([{ id: 7, body: 'FF0080' }]),
    );
    f.run(validate);
    expect(hook.attempts).toBe(2);
    expect(hook.opened[0]?.calls).toEqual([]);
    expect(hook.opened[0]?.database.open).toBe(false);
    expect(validate).toHaveBeenCalledOnce();
    f.verify();
});

function expectUnadmitted(f: ReturnType<typeof fixture>, attempts: number): void {
    expect(hook.attempts).toBe(attempts);
    expect(hook.opened).toHaveLength(attempts);
    for (const { database, calls } of hook.opened) {
        expect(database.open).toBe(false);
        expect(calls).toEqual([]);
    }
    expect(statSync(f.destination).size).toBe(0);
    expect(readFileSync(f.source)).toEqual(f.originalBytes);
}

it.skipIf(process.platform !== 'darwin')('exhausts continuous adjacent churn without admitting a handle or copying pages', () => {
    const f = fixture();
    hook.before = f.churn;
    const validate = vi.fn();
    expect(() => f.run(validate)).toThrow('managed database path changed while SQLite opened');
    expectUnadmitted(f, DATABASE_LIFECYCLE_OPEN_SEAL_ATTEMPTS);
    expect(validate).not.toHaveBeenCalled();
    expect(inspectDatabaseImportSource(f.source).identity).toEqual(f.identity);
});

it.skipIf(process.platform !== 'darwin')('retains an unproven handle and its proof when close fails instead of constructing again', () => {
    const f = fixture();
    hook.before = f.churn;
    let closeAttempts = 0;
    hook.after = (database) => {
        const close = database.close.bind(database);
        database.close = () => {
            if (++closeAttempts === 1) throw new Error('forced source handle close failure');
            return close();
        };
    };
    let caught: unknown;
    try {
        f.run();
    } catch (error) {
        caught = error;
    }
    expect(caught).toBeInstanceOf(AggregateError);
    expect((caught as AggregateError).errors.map(String)).toEqual([
        expect.stringContaining('managed database path changed while SQLite opened'),
        expect.stringContaining('forced source handle close failure'),
    ]);
    expect(hook.attempts).toBe(1);
    const opened = hook.opened[0];
    expect(opened?.database.open).toBe(true);
    expect(opened?.calls).toEqual([]);
    expect(statSync(f.destination).size).toBe(0);
    // The lifecycle retains the failed handle and proof until an explicit
    // close proves both are released; the importer must not restart first.
    opened?.database.close();
    expect(closeAttempts).toBe(2);
    expectUnadmitted(f, 1);
});

it.skipIf(process.platform !== 'darwin')('reports proof descriptor cleanup failure without another source construction', () => {
    const f = fixture();
    const mutableFs = createRequire(import.meta.url)('node:fs') as typeof import('node:fs');
    const originalOpen = mutableFs.openSync;
    const originalClose = mutableFs.closeSync;
    const pinnedSourceDescriptors = new Set<number>();
    let attemptDescriptor: number | undefined;
    let failedDescriptor: number | undefined;
    mutableFs.openSync = (...args) => {
        const descriptor = originalOpen(...args);
        if (args[0] === f.source) pinnedSourceDescriptors.add(descriptor);
        return descriptor;
    };
    mutableFs.closeSync = (descriptor) => {
        if (failedDescriptor === undefined && descriptor === attemptDescriptor) {
            failedDescriptor = descriptor;
            throw new Error('forced source proof descriptor close failure');
        }
        originalClose(descriptor);
        pinnedSourceDescriptors.delete(descriptor);
    };
    hook.before = () => {
        // The original preflight seal and the fresh construction proof are
        // both live. Fail release of the latter, not an inspection descriptor.
        expect(pinnedSourceDescriptors.size).toBe(2);
        attemptDescriptor = [...pinnedSourceDescriptors].at(-1);
        f.churn();
    };
    syncBuiltinESMExports();
    let caught: unknown;
    try {
        f.run();
    } catch (error) {
        caught = error;
    } finally {
        mutableFs.openSync = originalOpen;
        mutableFs.closeSync = originalClose;
        syncBuiltinESMExports();
        if (failedDescriptor !== undefined) originalClose(failedDescriptor);
    }
    expect(failedDescriptor).toBeDefined();
    expect(caught).toBeInstanceOf(AggregateError);
    expect((caught as AggregateError).errors.map(String)).toEqual([
        expect.stringContaining('managed database path changed while SQLite opened'),
        expect.stringContaining('forced source proof descriptor close failure'),
    ]);
    expectUnadmitted(f, 1);
});

it.each(['key validation', 'source validation', 'copy transaction'] as const)('never retries admitted %s failure', (phase) => {
    const f = fixture();
    const validate = vi.fn((database: Database.Database) => {
        if (phase === 'source validation') throw new Error('forced source validation failure');
        if (phase === 'copy transaction') {
            const prepare = database.prepare.bind(database);
            vi.spyOn(database, 'prepare').mockImplementation((sql) => {
                if (sql.includes('sqlite_master')) throw new Error('forced copy failure');
                return prepare(sql);
            });
        }
    });
    const wrongKey = Buffer.alloc(fixtureKey.length, 99);
    expect(() => f.run(validate, phase === 'key validation' ? wrongKey : fixtureKey)).toThrow();
    expect(hook.attempts).toBe(1);
    expect(hook.opened[0]?.database.open).toBe(false);
    expect(hook.opened[0]?.calls).toContain('filename');
    expect(hook.opened[0]?.calls).toContain('key');
    expect(validate).toHaveBeenCalledTimes(phase === 'key validation' ? 0 : 1);
    expect(readFileSync(f.source)).toEqual(f.originalBytes);
    if (phase !== 'copy transaction') expect(statSync(f.destination).size).toBe(0);
});

it.each([false, true])('never admits a substituted file (restored: %s) or accepts its changed ctime as authority', (restore) => {
    const f = fixture();
    const parked = path.join(f.sourceParent, 'parked.db');
    const decoy = path.join(f.root, 'decoy.db');
    copyFileSync(f.source, decoy);
    hook.before = () => {
        renameSync(f.source, parked);
        copyFileSync(decoy, f.source);
    };
    hook.after = () => {
        if (restore) {
            unlinkSync(f.source);
            renameSync(parked, f.source);
        }
    };
    const validate = vi.fn();
    expect(() => f.run(validate)).toThrow();
    expect(hook.attempts).toBe(1);
    expect(hook.opened[0]?.calls).toEqual([]);
    expect(hook.opened[0]?.database.open).toBe(false);
    expect(validate).not.toHaveBeenCalled();
    expect(statSync(f.destination).size).toBe(0);
    expect(readFileSync(restore ? f.source : parked)).toEqual(f.originalBytes);
    if (restore) {
        const after = inspectDatabaseImportSource(f.source).identity;
        expect(after.dev).toBe(f.identity.dev);
        expect(after.ino).toBe(f.identity.ino);
        expect(after.ctimeNs).not.toBe(f.identity.ctimeNs);
    }
});

it.skipIf(process.platform !== 'darwin').for([false, true])(
    'never admits a substituted ancestor (restored: %s); a fresh original must pass every seal',
    (restore, { skip }) => {
        const f = fixture();
        const ancestor = path.dirname(f.sourceParent);
        const parked = path.join(f.root, 'parked-source');
        const discarded = path.join(f.root, 'discarded-source');
        const decoy = path.join(f.root, 'decoy.db');
        copyFileSync(f.source, decoy);
        let denied: NodeJS.ErrnoException | undefined;
        hook.before = () => {
            if (hook.attempts !== 1) return;
            try {
                renameSync(ancestor, parked);
            } catch (error) {
                // A denied rename never constructs the substituted SQLite
                // handle. Permitted runs exercise the full replacement proof.
                if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
                denied = error as NodeJS.ErrnoException;
                throw error;
            }
            mkdirSync(f.sourceParent, { recursive: true });
            copyFileSync(decoy, f.source);
        };
        hook.after = () => {
            if (restore && hook.attempts === 1) {
                renameSync(ancestor, discarded);
                renameSync(parked, ancestor);
            }
        };
        const validate = vi.fn();
        if (restore) {
            let caught: unknown;
            try {
                f.run(validate);
            } catch (error) {
                caught = error;
            }
            if (denied !== undefined) {
                expect(caught).toBe(denied);
            } else {
                expect(caught).toBeUndefined();
                expect(hook.attempts).toBe(2);
                expect(hook.opened[0]?.calls).toEqual([]);
                expect(hook.opened[0]?.database.open).toBe(false);
                expect(validate).toHaveBeenCalledOnce();
                f.verify();
                return;
            }
        } else {
            expect(() => f.run(validate)).toThrow();
        }
        expect(hook.attempts).toBe(1);
        expect(hook.opened).toHaveLength(denied === undefined ? 1 : 0);
        for (const { database, calls } of hook.opened) {
            expect(database.open).toBe(false);
            expect(calls).toEqual([]);
        }
        expect(validate).not.toHaveBeenCalled();
        expect(statSync(f.destination).size).toBe(0);
        expect(readFileSync(denied === undefined ? path.join(parked, 'nested', 'original.db') : f.source)).toEqual(f.originalBytes);
        if (denied !== undefined) skip('Ancestor replacement was denied before SQLite construction; full substitution proof was not run.');
    },
);
