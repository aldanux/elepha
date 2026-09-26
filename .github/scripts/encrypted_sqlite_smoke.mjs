import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3-multiple-ciphers';

const directory = mkdtempSync(path.join(tmpdir(), 'elepha-encrypted-sqlite-smoke-'));
const databasePath = path.join(directory, 'smoke.db');
const key = randomBytes(32);

function rawKey() {
    return Buffer.from(`raw:${key.toString('hex')}`, 'ascii');
}

function keyDatabase(database) {
    database.pragma("cipher='chacha20'");
    const value = rawKey();
    try {
        database.key(value);
    } finally {
        value.fill(0);
    }
    database.prepare('SELECT name FROM sqlite_master LIMIT 1').get();
}

try {
    const created = new Database(databasePath);
    created.exec("CREATE VIRTUAL TABLE records USING fts5(body); INSERT INTO records (body) VALUES ('encrypted elephant');");
    const value = rawKey();
    try {
        created.pragma("cipher='chacha20'");
        created.rekey(value);
    } finally {
        value.fill(0);
        created.close();
    }

    if (readFileSync(databasePath).subarray(0, 16).toString('binary') === 'SQLite format 3\0') {
        throw new Error('Encrypted SQLite smoke database retained a plaintext header.');
    }

    const writable = new Database(databasePath, { fileMustExist: true });
    keyDatabase(writable);
    writable.prepare('INSERT INTO records (body) VALUES (?)').run('writable reopen');
    writable.close();

    const readonly = new Database(databasePath, { readonly: true, fileMustExist: true });
    keyDatabase(readonly);
    const match = readonly.prepare("SELECT COUNT(*) AS count FROM records WHERE records MATCH 'elephant'").get();
    const integrity = readonly.pragma('integrity_check');
    let readonlyWriteRejected = false;
    try {
        readonly.prepare('INSERT INTO records (body) VALUES (?)').run('must fail');
    } catch {
        readonlyWriteRejected = true;
    }
    readonly.close();
    if (!readonlyWriteRejected || match.count !== 1 || integrity.length !== 1 || integrity[0]?.integrity_check !== 'ok') {
        throw new Error('Encrypted SQLite smoke verification failed.');
    }
} finally {
    key.fill(0);
    rmSync(directory, { recursive: true, force: true });
}
