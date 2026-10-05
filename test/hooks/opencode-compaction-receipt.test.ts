import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
    OPENCODE_COMPACTION_RECEIPT_CONTRACT,
    OPENCODE_COMPACTION_RECEIPT_MAX_TEXT_BYTES,
    OPENCODE_COMPACTION_RECEIPTS_PER_SESSION,
} from '../../src/config/constants.js';
import { parseOpencodeCompactionReceipt, runOpencodeCompactionReceipt } from '../../src/hooks/opencode-compaction-receipt.js';
import { detectShellSyntax } from '../../src/security/sanitize.js';
import { openUnmanagedDb } from '../../src/storage/db.js';
import { createTestDb, seedConsentRoot, seedProject } from '../helpers/db.js';

const nativeId = 'ses_receipt_test';

function payload(cwd: string, overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({
        contract: OPENCODE_COMPACTION_RECEIPT_CONTRACT,
        session_id: nativeId,
        cwd,
        session_root: true,
        text: 'Remember the completed summary',
        reason: 'manual',
        ...overrides,
    });
}

describe('OpenCode V2 completed-compaction receipt', () => {
    it('rejects malformed, child, and oversized observations before persistence', () => {
        for (const value of [
            '{}',
            payload('/project', { contract: 'unsupported-compaction-contract' }),
            payload('/project', { session_root: false }),
            payload('/project', { reason: 'spoofed' }),
            payload('/project', { text: 'x'.repeat(OPENCODE_COMPACTION_RECEIPT_MAX_TEXT_BYTES + 1) }),
            payload('/project', { extra: 'spoofed' }),
        ])
            expect(parseOpencodeCompactionReceipt(value)).toBeUndefined();
    });

    it('stores only current consented native V2 chat observations and sanitizes text', async () => {
        const fixture = createTestDb('opencode-compaction-receipt-');
        const cwd = path.join(fixture.directory, 'project');
        mkdirSync(cwd, { recursive: true });
        const project = seedProject(fixture, { path: cwd });
        seedConsentRoot(fixture, { path: cwd });
        fixture.store.upsertSession('opencode', nativeId, project.id, path.join(fixture.directory, 'v2.db'), {
            sourceFormat: 'opencode-v2',
            kind: 'main',
        });
        fixture.close();
        const log: string[] = [];
        let observedAt = Date.parse('2026-09-28T00:00:00.000Z');
        const dependencies = { dbPath: fixture.dbPath, now: () => observedAt, log: (line: string) => log.push(line) };
        expect(await runOpencodeCompactionReceipt(payload(cwd, { text: 'Summary $(danger) `command`' }), dependencies)).toBe('stored');
        expect(await runOpencodeCompactionReceipt(payload(cwd, { text: 'Summary $(danger) `command`' }), dependencies)).toBe('stored');
        observedAt += 2_000;
        expect(await runOpencodeCompactionReceipt(payload(cwd, { text: 'Summary $(danger) `command`' }), dependencies)).toBe('stored');
        const db = openUnmanagedDb(fixture.dbPath);
        try {
            const rows = db.prepare('SELECT summary, coverage FROM opencode_compaction_receipts').all() as Array<{
                summary: string;
                coverage: string;
            }>;
            expect(rows).toHaveLength(3);
            expect(detectShellSyntax(rows[0]!.summary)).toBe(false);
            expect(rows[0]!.coverage).toBe('volatile_unverified');
            db.prepare("UPDATE consent_roots SET state = 'denied' WHERE path = ?").run(cwd);
        } finally {
            db.close();
        }
        expect(await runOpencodeCompactionReceipt(payload(cwd, { text: 'later' }), dependencies)).toBe('unavailable');
        expect(log.some((line) => line.includes('unconsented'))).toBe(true);
        const purge = openUnmanagedDb(fixture.dbPath);
        try {
            purge.prepare("DELETE FROM sessions WHERE tool = 'opencode' AND native_id = ?").run(nativeId);
            expect((purge.prepare('SELECT COUNT(*) AS count FROM opencode_compaction_receipts').get() as { count: number }).count).toBe(0);
        } finally {
            purge.close();
        }
    });

    it('rejects unknown native sessions and retains only the newest bounded observations', async () => {
        const fixture = createTestDb('opencode-compaction-retention-');
        const cwd = path.join(fixture.directory, 'project');
        mkdirSync(cwd, { recursive: true });
        const project = seedProject(fixture, { path: cwd });
        seedConsentRoot(fixture, { path: cwd });
        fixture.close();
        const dependencies = { dbPath: fixture.dbPath, log: () => undefined };
        expect(await runOpencodeCompactionReceipt(payload(cwd), dependencies)).toBe('unavailable');
        const db = openUnmanagedDb(fixture.dbPath);
        db.prepare(`INSERT INTO sessions (tool, native_id, project_id, source_path, source_format, started_at, last_ingested_at, kind)
            VALUES ('opencode', ?, ?, ?, 'native', ?, ?, 'main')`).run(
            nativeId,
            project.id,
            path.join(fixture.directory, 'v2.db'),
            new Date().toISOString(),
            new Date().toISOString(),
        );
        db.close();
        expect(await runOpencodeCompactionReceipt(payload(cwd), dependencies)).toBe('unavailable');
        const move = openUnmanagedDb(fixture.dbPath);
        move.prepare("UPDATE sessions SET source_format = 'opencode-v2', kind = 'subagent' WHERE native_id = ?").run(nativeId);
        move.close();
        expect(await runOpencodeCompactionReceipt(payload(cwd), dependencies)).toBe('unavailable');
        const restore = openUnmanagedDb(fixture.dbPath);
        restore.prepare("UPDATE sessions SET kind = 'main' WHERE native_id = ?").run(nativeId);
        restore.close();
        for (let i = 0; i <= OPENCODE_COMPACTION_RECEIPTS_PER_SESSION; i++) {
            expect(await runOpencodeCompactionReceipt(payload(cwd, { text: `summary ${i}` }), dependencies)).toBe('stored');
        }
        const verify = openUnmanagedDb(fixture.dbPath);
        try {
            const rows = verify.prepare('SELECT summary FROM opencode_compaction_receipts ORDER BY id').all() as Array<{ summary: string }>;
            expect(rows).toHaveLength(OPENCODE_COMPACTION_RECEIPTS_PER_SESSION);
            expect(rows[0]!.summary).toBe('summary 1');
        } finally {
            verify.close();
        }
    });

    it('adds the receipt table to a prior database and leaves it intact on reopen', () => {
        const fixture = createTestDb('opencode-compaction-migration-');
        fixture.db.exec('DROP TABLE opencode_compaction_receipts');
        fixture.close();
        for (let reopen = 0; reopen < 2; reopen++) {
            const db = openUnmanagedDb(fixture.dbPath);
            try {
                const table = db
                    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'opencode_compaction_receipts'")
                    .get();
                expect(table).toBeDefined();
            } finally {
                db.close();
            }
        }
    });
});
