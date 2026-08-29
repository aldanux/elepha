// Purge deleted rows from the tables but left them sitting in
// elepha.db-wal (~950KB observed) - a WAL page isn't overwritten until a
// checkpoint reclaims it, so "revocation = deletion" wasn't true of the file
// on disk. PRAGMA wal_checkpoint(TRUNCATE) after the purge transaction closes
// that gap.

import { existsSync, mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDb } from '../../src/storage/db.js';
import { MemoryStore } from '../../src/storage/memory-store.js';
import type { ParsedTurn } from '../../src/types/index.js';

function makeTurn(i: number, cwd: string, sessionId: string): ParsedTurn {
    const t = new Date(Date.UTC(2026, 7, 1, 0, 0, i)).toISOString();
    return {
        tool: 'claude-code',
        sessionId,
        sourcePath: path.join(cwd, 'session.jsonl'),
        projectPath: cwd,
        turnIndex: i,
        startedAt: t,
        endedAt: t,
        userMessage: `msg ${i} ${'x'.repeat(2000)}`,
        assistantText: 'reply',
        toolCalls: [],
        cursor: `${i}|${i + 1}`,
        hasExternalContent: false,
        resumeMarkerBefore: false,
    };
}

describe('purge WAL checkpoint', () => {
    it('truncates the WAL file after purging', () => {
        const root = mkdtempSync(path.join(tmpdir(), 'elepha-wal-'));
        const dbPath = path.join(root, 'elepha.db');
        const db = openDb(dbPath);
        const store = new MemoryStore(db);

        const cwd = path.join(root, 'workspace');
        const project = store.upsertProject(cwd);
        const session = store.upsertSession('claude-code', 'sess-1', project.id, path.join(cwd, 'session.jsonl'));

        for (let i = 0; i < 300; i++) {
            store.recordTurn(makeTurn(i, cwd, 'sess-1'), session.id, project.id, {
                decisions: [{ what: 'd', why: null }],
                pending_items: [],
                status: 'ok',
            });
        }

        const walPath = `${dbPath}-wal`;
        expect(existsSync(walPath)).toBe(true);
        expect(statSync(walPath).size).toBeGreaterThan(0);

        store.purge({ all: true });

        expect(statSync(walPath).size).toBe(0);
    });
});
