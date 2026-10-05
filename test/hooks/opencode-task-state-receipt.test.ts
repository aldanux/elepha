import { mkdirSync, renameSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { OPENCODE_TASK_STATE_RECEIPT_CONTRACT, OPENCODE_TASK_STATE_RECEIPTS_PER_SESSION } from '../../src/config/constants.js';
import { parseOpencodeTaskStateReceipt, runOpencodeTaskStateReceipt } from '../../src/hooks/opencode-task-state-receipt.js';
import { ConsentStore } from '../../src/storage/consent-store.js';
import { openUnmanagedDb } from '../../src/storage/db.js';
import { createTestDb, seedConsentRoot, seedProject } from '../helpers/db.js';

const nativeId = 'ses_task_receipt';
const requestId = `01J${'0'.repeat(23)}`;
const report = {
    mode: 'postcompact_retained',
    request_id: requestId,
    objective: { text: 'Continue safely' },
    decisions: [],
    constraints: [],
    pending_items: [],
};

function payload(cwd: string, overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({
        contract: OPENCODE_TASK_STATE_RECEIPT_CONTRACT,
        session_id: nativeId,
        cwd,
        session_root: true,
        assistant_message_id: 'msg_a',
        call_id: 'call_a',
        started_event_id: 'evt_start',
        called_event_id: 'evt_call',
        success_event_id: 'evt_success',
        report,
        ...overrides,
    });
}

describe('OpenCode V2 task-state call receipt', () => {
    it('rejects malformed, spoofed, child, and oversized payloads', () => {
        for (const raw of [
            '{}',
            payload('/project', { contract: 'other' }),
            payload('/project', { session_root: false }),
            payload('/project', { success_event_id: 'evt_start' }),
            payload('/project', { report: { ...report, request_id: 'invalid' } }),
            payload('/project', { report: { ...report, objective: { text: 'x'.repeat(40_000) } } }),
            payload('/project', { extra: 'spoofed' }),
        ])
            expect(parseOpencodeTaskStateReceipt(raw)).toBeUndefined();
    });

    it('stores a bounded digest without report text and idempotently accepts exact replay', async () => {
        const fixture = createTestDb('opencode-task-state-receipt-');
        const cwd = path.join(fixture.directory, 'project');
        mkdirSync(cwd, { recursive: true });
        const project = seedProject(fixture, { path: cwd });
        seedConsentRoot(fixture, { path: cwd });
        fixture.store.upsertSession('opencode', nativeId, project.id, path.join(fixture.directory, 'v2.db'), {
            sourceFormat: 'opencode-v2',
            kind: 'main',
        });
        fixture.close();
        const dependencies = { dbPath: fixture.dbPath, log: () => undefined };
        expect(await runOpencodeTaskStateReceipt(payload(cwd), dependencies)).toBe('stored');
        expect(await runOpencodeTaskStateReceipt(payload(cwd), dependencies)).toBe('duplicate');
        expect(await runOpencodeTaskStateReceipt(payload(cwd, { success_event_id: 'evt_different' }), dependencies)).toBe('unavailable');
        const db = openUnmanagedDb(fixture.dbPath);
        try {
            const rows = db.prepare('SELECT * FROM opencode_task_state_receipts').all() as Array<Record<string, unknown>>;
            expect(rows).toHaveLength(1);
            expect(rows[0]!.request_id).toBe(requestId);
            expect(rows[0]!.report_digest).toMatch(/^[a-f0-9]{64}$/);
            expect(rows[0]!.coverage).toBe('volatile_unverified');
            expect(JSON.stringify(rows[0])).not.toContain('Continue safely');
            db.prepare("UPDATE sessions SET kind = 'subagent' WHERE native_id = ?").run(nativeId);
        } finally {
            db.close();
        }
        expect(await runOpencodeTaskStateReceipt(payload(cwd, { call_id: 'child_call' }), dependencies)).toBe('unavailable');
    });

    it('rejects sibling checkout, revoked consent, and purged native chat', async () => {
        const fixture = createTestDb('opencode-task-state-authority-');
        const cwd = path.join(fixture.directory, 'project');
        const sibling = path.join(fixture.directory, 'sibling');
        mkdirSync(cwd, { recursive: true });
        mkdirSync(sibling, { recursive: true });
        const project = seedProject(fixture, { path: cwd });
        seedConsentRoot(fixture, { path: cwd });
        seedConsentRoot(fixture, { path: sibling });
        fixture.store.upsertSession('opencode', nativeId, project.id, path.join(fixture.directory, 'v2.db'), {
            sourceFormat: 'opencode-v2',
            kind: 'main',
        });
        fixture.close();
        const dependencies = { dbPath: fixture.dbPath, log: () => undefined };
        expect(await runOpencodeTaskStateReceipt(payload(sibling), dependencies)).toBe('unavailable');
        const db = openUnmanagedDb(fixture.dbPath);
        db.prepare("UPDATE consent_roots SET state = 'denied' WHERE path = ?").run(cwd);
        db.close();
        expect(await runOpencodeTaskStateReceipt(payload(cwd), dependencies)).toBe('unavailable');
        const restored = openUnmanagedDb(fixture.dbPath);
        restored.prepare("UPDATE consent_roots SET state = 'approved' WHERE path = ?").run(cwd);
        restored
            .prepare("INSERT INTO purged_transcripts (tool, native_id, purged_at) VALUES ('opencode', ?, ?)")
            .run(nativeId, new Date().toISOString());
        restored.close();
        expect(await runOpencodeTaskStateReceipt(payload(cwd), dependencies)).toBe('unavailable');
    });

    it('rejects a physical checkout swap immediately before the transaction write', async () => {
        const fixture = createTestDb('opencode-task-state-path-race-');
        const cwd = path.join(fixture.directory, 'project');
        const sibling = path.join(fixture.directory, 'sibling');
        mkdirSync(cwd, { recursive: true });
        mkdirSync(sibling, { recursive: true });
        const project = seedProject(fixture, { path: cwd });
        seedConsentRoot(fixture, { path: cwd });
        seedConsentRoot(fixture, { path: sibling });
        fixture.store.upsertSession('opencode', nativeId, project.id, path.join(fixture.directory, 'v2.db'), {
            sourceFormat: 'opencode-v2',
            kind: 'main',
        });
        fixture.close();
        const original = ConsentStore.prototype.isRefusedForCapture;
        let checks = 0;
        const probe = vi.spyOn(ConsentStore.prototype, 'isRefusedForCapture').mockImplementation(function (this: ConsentStore, candidate) {
            checks++;
            if (checks === 2) {
                renameSync(cwd, path.join(fixture.directory, 'moved-project'));
                symlinkSync(sibling, cwd, 'dir');
            }
            return original.call(this, candidate);
        });
        try {
            expect(await runOpencodeTaskStateReceipt(payload(cwd), { dbPath: fixture.dbPath, log: () => undefined })).toBe('unavailable');
            const db = openUnmanagedDb(fixture.dbPath);
            try {
                const rows = db.prepare('SELECT id FROM opencode_task_state_receipts').all();
                expect(rows).toHaveLength(0);
            } finally {
                db.close();
            }
        } finally {
            probe.mockRestore();
        }
    });

    it('rechecks capture refusal at mutation time', async () => {
        const fixture = createTestDb('opencode-task-state-refusal-race-');
        const cwd = path.join(fixture.directory, 'project');
        mkdirSync(cwd, { recursive: true });
        const project = seedProject(fixture, { path: cwd });
        seedConsentRoot(fixture, { path: cwd });
        fixture.store.upsertSession('opencode', nativeId, project.id, path.join(fixture.directory, 'v2.db'), {
            sourceFormat: 'opencode-v2',
            kind: 'main',
        });
        fixture.close();
        let checks = 0;
        const probe = vi.spyOn(ConsentStore.prototype, 'isRefusedForCapture').mockImplementation(() => ++checks > 1);
        try {
            expect(await runOpencodeTaskStateReceipt(payload(cwd), { dbPath: fixture.dbPath, log: () => undefined })).toBe('unavailable');
            expect(checks).toBeGreaterThan(1);
        } finally {
            probe.mockRestore();
        }
    });

    it('retains the newest bounded observations and migrates on reopen', async () => {
        const fixture = createTestDb('opencode-task-state-retention-');
        const cwd = path.join(fixture.directory, 'project');
        mkdirSync(cwd, { recursive: true });
        const project = seedProject(fixture, { path: cwd });
        seedConsentRoot(fixture, { path: cwd });
        fixture.store.upsertSession('opencode', nativeId, project.id, path.join(fixture.directory, 'v2.db'), {
            sourceFormat: 'opencode-v2',
            kind: 'main',
        });
        fixture.db.exec('DROP TABLE opencode_task_state_receipts');
        fixture.close();
        const dependencies = { dbPath: fixture.dbPath, log: () => undefined };
        for (let index = 0; index <= OPENCODE_TASK_STATE_RECEIPTS_PER_SESSION; index++) {
            expect(
                await runOpencodeTaskStateReceipt(
                    payload(cwd, {
                        call_id: `call_${index}`,
                        started_event_id: `evt_start_${index}`,
                        called_event_id: `evt_call_${index}`,
                        success_event_id: `evt_success_${index}`,
                    }),
                    dependencies,
                ),
            ).toBe('stored');
        }
        const db = openUnmanagedDb(fixture.dbPath);
        try {
            const rows = db.prepare('SELECT call_id FROM opencode_task_state_receipts ORDER BY id').all() as Array<{ call_id: string }>;
            expect(rows).toHaveLength(OPENCODE_TASK_STATE_RECEIPTS_PER_SESSION);
            expect(rows[0]!.call_id).toBe('call_1');
        } finally {
            db.close();
        }
    });
});
