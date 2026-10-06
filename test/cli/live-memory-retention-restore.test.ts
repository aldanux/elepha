import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3-multiple-ciphers';
import { describe, expect, it } from 'vitest';
import { runRestoreOperation } from '../../src/cli/commands/restore.js';
import { BACKUP_KEEP } from '../../src/config/constants.js';
import { listManagedBackups } from '../../src/storage/backup.js';
import { type DatabaseEncryptionRuntime, databaseKey } from '../../src/storage/database-encryption.js';
import { openDb, rekeyDatabaseConnection } from '../../src/storage/db.js';
import { isLiveMemoryCapacityGuardError } from '../../src/storage/live-memory-capacity-guard.js';
import { LIVE_MEMORY_RETENTION_POLICY, readLiveMemoryRetentionReport } from '../../src/storage/live-memory-retention.js';
import { measureLiveMemoryByNativeSession, nativeSessionKey, readLiveMemoryUsage } from '../../src/storage/live-memory-usage.js';
import { MemoryStore } from '../../src/storage/memory-store.js';
import type { ParsedTurn } from '../../src/types/index.js';
import { createTestDb } from '../helpers/db.js';

const FIXED_KEY = Buffer.alloc(32, 9);
const NOW = Date.parse('2026-09-30T00:00:00.000Z');
const OLD = '2026-02-01T00:00:00.000Z';
const summary = { decisions: [], pending_items: [], status: 'not_configured' as const };
const notRunning = () => ({ state: 'NOT RUNNING', healthy: false });

function encryptionRuntime(): DatabaseEncryptionRuntime {
    return {
        platform: 'linux',
        env: { CI: '1' },
        randomBytes: () => Buffer.from(FIXED_KEY),
        randomUUID: () => '22222222-2222-4222-8222-222222222222',
        keyFilePath: (dbPath) => path.join(path.dirname(dbPath), 'retention.keydata'),
    };
}

function turn(nativeId: string, projectPath: string, turnIndex: number, text: string): ParsedTurn {
    return {
        tool: 'codex',
        sessionId: nativeId,
        sourcePath: path.join(projectPath, `${nativeId}.jsonl`),
        projectPath,
        turnIndex,
        startedAt: OLD,
        endedAt: OLD,
        userMessage: text,
        assistantText: `answer ${nativeId}`,
        toolCalls: [],
        cursor: `${turnIndex + 1}`,
        hasExternalContent: false,
        resumeMarkerBefore: false,
    };
}

function sessions(db: Database.Database): string[] {
    return (db.prepare('SELECT DISTINCT native_id FROM sessions ORDER BY native_id').all() as Array<{ native_id: string }>).map(
        (row) => row.native_id,
    );
}

function ftsHits(db: Database.Database, term: string): number {
    return (db.prepare('SELECT rowid FROM filtered_turns_fts WHERE filtered_turns_fts MATCH ?').all(term) as unknown[]).length;
}

describe('restoring a pre-cleanup backup', () => {
    it('brings back automatically removed evidence while purge and incognito decisions keep their protection', async () => {
        const fixture = createTestDb('elepha-retention-restore-');
        const projectPath = path.join(fixture.directory, 'project');
        mkdirSync(projectPath);
        fixture.store.consent.grant(projectPath);
        const project = fixture.store.upsertProject(projectPath);
        for (const [nativeId, startedAt] of [
            ['oldest', '2026-01-01T00:00:00.000Z'],
            ['purgeme', '2026-01-02T00:00:00.000Z'],
            ['hideme', '2026-01-03T00:00:00.000Z'],
        ] as const) {
            const session = fixture.store.upsertSession('codex', nativeId, project.id, path.join(projectPath, `${nativeId}.jsonl`));
            fixture.store.recordTurn(
                turn(nativeId, projectPath, 0, `needle${nativeId} ${'x'.repeat(300)}`),
                session.id,
                project.id,
                summary,
                true,
            );
            fixture.db
                .prepare('UPDATE sessions SET started_at = ?, last_ingested_at = ? WHERE native_id = ?')
                .run(startedAt, OLD, nativeId);
        }
        fixture.close();
        const runtime = encryptionRuntime();
        const key = await databaseKey(fixture.dbPath, true, runtime);
        const plain = new Database(fixture.dbPath, { fileMustExist: true });
        rekeyDatabaseConnection(plain, key);
        plain.close();
        key.fill(0);

        const olderBackups = Array.from({ length: BACKUP_KEEP }, (_, index) => `${fixture.dbPath}.bak-1999-01-0${index + 1}`);
        for (const backup of olderBackups) copyFileSync(fixture.dbPath, backup);
        const unrelatedBackup = path.join(fixture.directory, 'unrelated.db.bak-1999-01-01');
        copyFileSync(fixture.dbPath, unrelatedBackup);

        const db = await openDb(fixture.dbPath, { encryption: runtime });
        const usage = readLiveMemoryUsage(db);
        const oldest = measureLiveMemoryByNativeSession(db).get(nativeSessionKey('codex', 'oldest'))!.bytes;
        const current = turn('current', projectPath, 0, `needlecurrent ${'y'.repeat(600)}`);
        const rollback = new Error('measure');
        let write = 0;
        try {
            db.transaction(() => {
                new MemoryStore(db, { resolveGitRoot: () => null, resolveGitRemote: () => null }).recordIngestedTurn(
                    current,
                    {},
                    false,
                    summary,
                    true,
                );
                write = readLiveMemoryUsage(db) - usage;
                throw rollback;
            })();
        } catch (error) {
            if (error !== rollback) throw error;
        }
        const store = new MemoryStore(db, {
            resolveGitRoot: () => null,
            resolveGitRemote: () => null,
            liveMemoryRetention: {
                ...LIVE_MEMORY_RETENTION_POLICY,
                capacityBytes: usage + 1,
                targetBytes: usage + write - oldest,
                warningBytes: 0,
                now: () => NOW,
            },
        });
        expect(store.recordIngestedTurn(current, {}, false, summary, true)?.inserted).toBe(true);
        expect(sessions(db)).toEqual(['current', 'hideme', 'purgeme']);
        const backupPath = readLiveMemoryRetentionReport(db, 10).state?.backup_path;
        expect(backupPath).toBeDefined();
        expect(path.dirname(backupPath!)).toBe(fixture.directory);
        expect(statSync(backupPath!).mode & 0o777).toBe(0o600);
        expect(readFileSync(backupPath!).subarray(0, 16).toString('binary')).not.toBe('SQLite format 3\0');
        expect(listManagedBackups(fixture.dbPath)).toEqual([...olderBackups.slice(1), backupPath]);
        expect(existsSync(unrelatedBackup)).toBe(true);
        // Genuine user decisions made after the cleanup: purge one chat, make another incognito.
        const purgeAt = '2026-03-03T00:00:00.000Z';
        db.prepare("UPDATE sessions SET last_ingested_at = ? WHERE native_id = 'purgeme'").run(purgeAt);
        expect(store.purge({ newerThan: purgeAt, olderThan: purgeAt }).sessions.map((row) => row.nativeId)).toEqual(['purgeme']);
        store.recordIncognitoTranscript('codex', 'hideme');
        db.close();

        await runRestoreOperation(backupPath!, { dbPath: fixture.dbPath, encryption: runtime, daemonHealth: notRunning });

        const restored = await openDb(fixture.dbPath, { encryption: runtime });
        try {
            // The automatically removed session comes back with its search index.
            expect(sessions(restored)).toContain('oldest');
            expect(ftsHits(restored, 'needleoldest')).toBe(1);
            expect(readLiveMemoryRetentionReport(restored, 10).removedSessions).toBe(0);
            const restoredStore = new MemoryStore(restored, { resolveGitRoot: () => null, resolveGitRemote: () => null });
            expect(restoredStore.isTranscriptRetentionRemoved('codex', 'oldest')).toBe(false);
            // Purge and incognito decisions made after the backup still hold.
            expect(restoredStore.isTranscriptPurged('codex', 'purgeme')).toBe(true);
            expect(restoredStore.isTranscriptIncognito('codex', 'hideme')).toBe(true);
            expect(ftsHits(restored, 'needlepurgeme')).toBe(0);
            expect(ftsHits(restored, 'needlehideme')).toBe(0);
            // Capture of the restored session works again; the others stay refused.
            expect(restoredStore.recordIngestedTurn(turn('oldest', projectPath, 1, 'continues'), {}, false, summary, true)?.inserted).toBe(
                true,
            );
            expect(restoredStore.recordIngestedTurn(turn('purgeme', projectPath, 1, 'refused'), {}, false, summary, true)).toBeUndefined();
            expect(restoredStore.recordIngestedTurn(turn('hideme', projectPath, 1, 'refused'), {}, false, summary, true)).toBeUndefined();
        } finally {
            restored.close();
        }
    });

    it('refuses to install a backup whose live memory is at or above capacity', async () => {
        const active = createTestDb('elepha-retention-restore-cap-active-');
        const candidate = createTestDb('elepha-retention-restore-cap-candidate-');
        const projectPath = path.join(candidate.directory, 'project');
        mkdirSync(projectPath);
        candidate.store.consent.grant(projectPath);
        const project = candidate.store.upsertProject(projectPath);
        const session = candidate.store.upsertSession('codex', 'big', project.id, path.join(projectPath, 'big.jsonl'));
        candidate.store.recordTurn(turn('big', projectPath, 0, 'x'.repeat(2_000)), session.id, project.id, summary, true);
        const capacity = readLiveMemoryUsage(candidate.db);
        const backupPath = path.join(candidate.directory, 'backup.db');
        candidate.db.prepare('VACUUM INTO ?').run(backupPath);
        const before = sessions(active.db);
        active.close();
        candidate.close();

        let caught: unknown;
        try {
            await runRestoreOperation(backupPath, { dbPath: active.dbPath, daemonHealth: notRunning, liveMemoryCapacityBytes: capacity });
        } catch (error) {
            caught = error;
        }

        expect(isLiveMemoryCapacityGuardError(caught)).toBe(true);
        const reopened = new Database(active.dbPath, { readonly: true });
        expect(sessions(reopened)).toEqual(before);
        reopened.close();
    });
});
