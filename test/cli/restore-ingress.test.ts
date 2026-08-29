import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { exportAll } from '../../src/cli/commands/backup.js';
import { runRestoreOperation } from '../../src/cli/commands/restore.js';
import { createTestDb, seedMemory, seedProject, seedRollup, seedSession, type TestDatabase } from '../helpers/db.js';

function seedCandidate(fixture: TestDatabase, nativeId: string): void {
    const project = seedProject(fixture);
    const session = seedSession(fixture, { project, nativeId });
    seedMemory(fixture, { project, session });
    seedRollup(fixture, { project, session });
    fixture.db.prepare('UPDATE session_rollups SET kind = ? WHERE session_id = ?').run('primary', session.id);
}

function sessionNativeIds(dbPath: string): string[] {
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
        return (db.prepare('SELECT native_id FROM sessions ORDER BY native_id').all() as Array<{ native_id: string }>).map(
            (row) => row.native_id,
        );
    } finally {
        db.close();
    }
}

describe('restore semantic ingress validation', () => {
    it('refuses a malformed staged candidate without swapping, while the repaired candidate still restores', async () => {
        const active = createTestDb('elepha-restore-ingress-active-');
        const candidate = createTestDb('elepha-restore-ingress-candidate-');
        seedCandidate(active, 'live-session');
        seedCandidate(candidate, 'candidate-session');
        const backup = path.join(candidate.directory, 'full.db');
        exportAll(candidate.db, backup);
        active.close();
        candidate.close();

        const poisoned = new Database(backup);
        poisoned.prepare('UPDATE session_rollups SET rollup_state = ?').run('poisoned');
        poisoned.close();
        const before = readFileSync(active.dbPath);

        await expect(
            runRestoreOperation(backup, {
                dbPath: active.dbPath,
                daemonHealth: () => ({ state: 'NOT RUNNING', healthy: false }),
            }),
        ).rejects.toThrow('session_rollups.rollup_state');
        expect(readFileSync(active.dbPath)).toEqual(before);
        expect(sessionNativeIds(active.dbPath)).toEqual(['live-session']);
        expect(readdirSync(active.directory).some((name) => name.startsWith('elepha.db.bak-'))).toBe(false);

        const repaired = new Database(backup);
        repaired.prepare('UPDATE session_rollups SET rollup_state = ?').run('final');
        repaired.close();

        await expect(
            runRestoreOperation(backup, {
                dbPath: active.dbPath,
                daemonHealth: () => ({ state: 'NOT RUNNING', healthy: false }),
            }),
        ).resolves.toMatchObject({ cancelled: false });
        expect(sessionNativeIds(active.dbPath)).toEqual(['candidate-session']);
    });
});
