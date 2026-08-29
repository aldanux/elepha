// ~/.elepha and everything in it (DB, WAL, backups, logs) was created
// at the process umask, typically 644/755 - world-readable. This is memory
// synthesized from session transcripts sitting in a location any local user
// or process can read. Tighten the directory to 0700 and files to 0600.

import { existsSync, mkdtempSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDb } from '../../src/storage/db.js';
import { SummarizerCallLog } from '../../src/summarizer/call-log.js';

function mode(p: string): number {
    return statSync(p).mode & 0o777;
}

describe('~/.elepha permissions', () => {
    it('creates the DB directory 0700 and the DB file 0600', () => {
        const root = mkdtempSync(path.join(tmpdir(), 'elepha-perms-'));
        const dbPath = path.join(root, '.elepha', 'elepha.db');

        openDb(dbPath);

        expect(mode(path.dirname(dbPath))).toBe(0o700);
        expect(mode(dbPath)).toBe(0o600);
    });

    it('creates the WAL/SHM sidecar files 0600 too', () => {
        const root = mkdtempSync(path.join(tmpdir(), 'elepha-perms-'));
        const dbPath = path.join(root, '.elepha', 'elepha.db');

        openDb(dbPath);

        const walPath = `${dbPath}-wal`;
        const shmPath = `${dbPath}-shm`;
        expect(existsSync(walPath) || existsSync(shmPath)).toBe(true);
        if (existsSync(walPath)) expect(mode(walPath)).toBe(0o600);
        if (existsSync(shmPath)) expect(mode(shmPath)).toBe(0o600);
    });

    it('creates the summarizer call-log directory 0700 and log files 0600', () => {
        const root = mkdtempSync(path.join(tmpdir(), 'elepha-perms-'));
        const logDir = path.join(root, '.elepha', 'logs');
        const log = new SummarizerCallLog(logDir);

        log.append({
            timestamp: new Date().toISOString(),
            job: 'turn_extraction',
            latencyMs: 10,
            inputTokens: 1,
            cacheCreationInputTokens: 0,
            cacheReadInputTokens: 0,
            outputTokens: 1,
            attempt: 1,
            rateLimited: false,
            error: null,
            status: 'ok',
        });

        expect(mode(logDir)).toBe(0o700);
        const files = readdirSync(logDir);
        expect(files.length).toBeGreaterThan(0);
        for (const f of files) {
            expect(mode(path.join(logDir, f))).toBe(0o600);
        }
    });
});
