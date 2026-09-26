import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HookTool } from '../../src/hooks/common.js';
import { runSessionStart, type SessionStartDependencies } from '../../src/hooks/session-start.js';
import { openUnmanagedDb } from '../../src/storage/db.js';
import { MemoryStore } from '../../src/storage/memory-store.js';
import { newUlid } from '../../src/storage/ulid.js';
import { createTestDb } from '../helpers/db.js';
import { withTempDir } from '../helpers/tmp.js';

const NOW = Date.parse('2026-09-26T00:00:00.000Z');
const GRANT_COMMAND = 'elepha consent grant --here';
const QUIET: SessionStartDependencies = {
    now: () => NOW,
    daemonHealth: () => ({ state: 'RUNNING', healthy: true }),
    readUpdateAvailable: () => undefined,
};

function codexWorktree(name = 'elepha'): { root: string; codexHome: string; gitDir: string; fixture: string } {
    const fixture = realpathSync(withTempDir('elepha-worktree-notice-'));
    const codexHome = path.join(fixture, '.codex');
    const root = path.join(codexHome, 'worktrees', 'e251', name);
    const gitDir = path.join(fixture, 'repository.git', 'worktrees', 'elepha');
    mkdirSync(root, { recursive: true });
    mkdirSync(gitDir, { recursive: true });
    writeFileSync(path.join(root, '.git'), `gitdir: ${gitDir}\n`);
    writeFileSync(path.join(gitDir, 'gitdir'), `${path.join(root, '.git')}\n`);
    writeFileSync(path.join(gitDir, 'commondir'), '../..\n');
    vi.stubEnv('CODEX_HOME', codexHome);
    return { root, codexHome, gitDir, fixture };
}

function dbPath(): string {
    const f = createTestDb('elepha-worktree-notice-db-');
    f.close();
    return f.dbPath;
}

function payload(cwd: string, sessionId: string, extra: Record<string, unknown> = {}): string {
    return JSON.stringify({
        session_id: sessionId,
        cwd,
        hook_event_name: 'SessionStart',
        source: 'startup',
        model: 'test',
        permission_mode: 'default',
        ...extra,
    });
}

async function start(database: string, cwd: string, sessionId: string, tool: HookTool = 'codex', extra: SessionStartDependencies = {}) {
    return runSessionStart(payload(cwd, sessionId), tool, { ...QUIET, dbPath: database, ...extra });
}

function notice(result: Awaited<ReturnType<typeof runSessionStart>>): string | undefined {
    if (!('output' in result)) return undefined;
    const value = result.output.systemMessage;
    return typeof value === 'string' ? value : undefined;
}

type ConsentRow = { path: string; state: string; nudged_at: string | null };

function consentRows(database: string): ConsentRow[] {
    const db = openUnmanagedDb(database);
    try {
        return db.prepare('SELECT path, state, nudged_at FROM consent_roots ORDER BY path').all() as ConsentRow[];
    } finally {
        db.close();
    }
}

// Seeds a non-CLI decision directly: grant() only ever writes source 'cli',
// and parents of a worktree fixture are refused roots that grant() rejects.
function insertDecision(database: string, rootPath: string, state: 'approved' | 'denied', source: 'discovery' | 'grandfathered'): void {
    const db = openUnmanagedDb(database);
    try {
        db.prepare('INSERT INTO consent_roots (ulid, path, state, decided_at, source) VALUES (?, ?, ?, ?, ?)').run(
            newUlid(),
            rootPath,
            state,
            new Date(NOW).toISOString(),
            source,
        );
    } finally {
        db.close();
    }
}

function withConsent<T>(database: string, action: (store: MemoryStore) => T): T {
    const db = openUnmanagedDb(database);
    try {
        return action(new MemoryStore(db));
    } finally {
        db.close();
    }
}

describe('SessionStart worktree consent notice', () => {
    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it('shows the exact root once across chats and tools, and never grants capture itself', async () => {
        const { root } = codexWorktree();
        const database = dbPath();

        const first = notice(await start(database, root, 'chat-a', 'codex'));
        expect(first).toContain(root);
        expect(first).toContain(GRANT_COMMAND);
        expect(consentRows(database)).toEqual([{ path: root, state: 'pending', nudged_at: new Date(NOW).toISOString() }]);

        await expect(start(database, root, 'chat-b', 'codex')).resolves.toEqual({ reason: 'no_notice' });
        await expect(start(database, root, 'chat-c', 'claude-code')).resolves.toEqual({ reason: 'no_notice' });

        expect(withConsent(database, (store) => store.consent.isRefusedForCapture(root))).toBe(true);
        mkdirSync(path.join(root, 'src'));
        withConsent(database, (store) => store.consent.grant(root));
        expect(withConsent(database, (store) => store.consent.isRefusedForCapture(root))).toBe(false);
        expect(withConsent(database, (store) => store.consent.isRefusedForCapture(path.join(root, 'src')))).toBe(false);
        await expect(start(database, root, 'chat-d', 'claude-code')).resolves.toEqual({ reason: 'no_notice' });
    });

    it('claims the notice once when SessionStart hooks race', async () => {
        const { root } = codexWorktree();
        const database = dbPath();

        const results = await Promise.all([
            start(database, root, 'race-a', 'codex'),
            start(database, root, 'race-b', 'claude-code'),
            start(database, root, 'race-c', 'codex'),
        ]);
        expect(results.map(notice).filter((text) => text !== undefined)).toHaveLength(1);
    });

    it('resolves a nested cwd to the exact worktree root', async () => {
        const { root } = codexWorktree();
        const nested = path.join(root, 'src', 'deep');
        mkdirSync(nested, { recursive: true });
        const database = dbPath();

        expect(notice(await start(database, nested, 'nested'))).toContain(root);
        expect(consentRows(database).map((row) => row.path)).toEqual([root]);
    });

    it('stays silent for a symlink escaping the root, provider state, broken worktrees and arbitrary directories', async () => {
        const { root, codexHome, gitDir, fixture } = codexWorktree();
        const outside = path.join(fixture, 'outside');
        mkdirSync(outside);
        symlinkSync(outside, path.join(root, 'escape'));
        const externalAlias = path.join(fixture, 'worktree-link');
        symlinkSync(root, externalAlias);
        const database = dbPath();

        for (const cwd of [
            path.join(root, 'escape'),
            externalAlias,
            codexHome,
            path.join(codexHome, 'worktrees', 'e251'),
            path.join(codexHome, 'sessions'),
            outside,
        ]) {
            mkdirSync(cwd, { recursive: true });
            await expect(start(database, cwd, `silent-${path.basename(cwd)}`)).resolves.toEqual({ reason: 'no_notice' });
        }

        writeFileSync(path.join(gitDir, 'gitdir'), '/other/worktree/.git\n');
        await expect(start(database, root, 'broken')).resolves.toEqual({ reason: 'no_notice' });
        expect(consentRows(database)).toEqual([]);
    });

    it('never nudges an explicitly denied or approved root', async () => {
        const denied = codexWorktree('denied');
        const database = dbPath();
        withConsent(database, (store) => store.consent.revoke(denied.root));
        await expect(start(database, denied.root, 'denied')).resolves.toEqual({ reason: 'no_notice' });
        expect(consentRows(database)).toEqual([expect.objectContaining({ path: denied.root, state: 'denied', nudged_at: null })]);

        const approved = codexWorktree('approved');
        const approvedDb = dbPath();
        withConsent(approvedDb, (store) => store.consent.grant(approved.root));
        await expect(start(approvedDb, approved.root, 'approved')).resolves.toEqual({ reason: 'no_notice' });
        expect(consentRows(approvedDb)).toEqual([expect.objectContaining({ state: 'approved', nudged_at: null })]);
    });

    it('still nudges once when a broad parent approval leaves the worktree refused, without changing that approval', async () => {
        const { root, fixture } = codexWorktree();
        const database = dbPath();
        insertDecision(database, fixture, 'approved', 'grandfathered');
        expect(withConsent(database, (store) => store.consent.isRefusedForCapture(root))).toBe(true);

        expect(notice(await start(database, root, 'parent-approved'))).toContain(root);
        await expect(start(database, root, 'parent-approved-again')).resolves.toEqual({ reason: 'no_notice' });

        expect(consentRows(database)).toEqual([
            { path: fixture, state: 'approved', nudged_at: null },
            { path: root, state: 'pending', nudged_at: new Date(NOW).toISOString() },
        ]);
        expect(withConsent(database, (store) => store.consent.isRefusedForCapture(root))).toBe(true);
    });

    it('still nudges once for an exact historical non-CLI approval, keeping it approved but refused', async () => {
        const { root } = codexWorktree();
        const database = dbPath();
        insertDecision(database, root, 'approved', 'grandfathered');

        expect(notice(await start(database, root, 'historical'))).toContain(root);
        await expect(start(database, root, 'historical-again')).resolves.toEqual({ reason: 'no_notice' });

        expect(consentRows(database)).toEqual([{ path: root, state: 'approved', nudged_at: new Date(NOW).toISOString() }]);
        expect(withConsent(database, (store) => store.consent.list())).toEqual([
            expect.objectContaining({ path: root, state: 'approved', source: 'grandfathered' }),
        ]);
        expect(withConsent(database, (store) => store.consent.isRefusedForCapture(root))).toBe(true);
    });

    it('stays silent under a denied parent even when an ancestor above it is approved', async () => {
        const { root, fixture, codexHome } = codexWorktree();
        const database = dbPath();
        insertDecision(database, fixture, 'approved', 'grandfathered');
        withConsent(database, (store) => store.consent.revoke(codexHome));

        await expect(start(database, root, 'parent-denied')).resolves.toEqual({ reason: 'no_notice' });
        expect(consentRows(database).map((row) => row.path)).toEqual([codexHome, fixture].sort());
    });

    it('keeps child-agent hooks silent without touching consent', async () => {
        const { root } = codexWorktree();
        const database = dbPath();

        const child = payload(root, 'parent', { agent_id: 'child', agent_type: 'Explore' });
        for (const tool of ['claude-code', 'codex'] as const) {
            await expect(runSessionStart(child, tool, { ...QUIET, dbPath: database })).resolves.toEqual({ reason: 'subagent_context' });
        }
        expect(consentRows(database)).toEqual([]);
    });

    it('does not consume the one-time notice when its output cannot be recorded', async () => {
        const { root } = codexWorktree();
        const database = dbPath();

        await expect(start(database, root, 'failed', 'codex', { writeInjection: () => false })).resolves.toEqual({
            reason: 'injection_record_failed',
        });
        expect(consentRows(database).filter((row) => row.nudged_at !== null)).toEqual([]);

        expect(notice(await start(database, root, 'retry'))).toContain(root);
    });

    it('neutralizes terminal escapes and shell syntax in the displayed root', async () => {
        const { root } = codexWorktree('bad\u001b[31m$(touch pwned)');
        const database = dbPath();

        const text = notice(await start(database, root, 'hostile'));
        expect(text).toContain(GRANT_COMMAND);
        expect(text).not.toContain('\u001b');
        expect(text).not.toContain('$(');
    });
});
