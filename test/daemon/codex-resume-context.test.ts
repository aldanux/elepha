import { appendFileSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3-multiple-ciphers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CodexAdapter } from '../../src/adapters/codex.js';
import { IngestionDaemon } from '../../src/daemon/index.js';
import { openUnmanagedDb } from '../../src/storage/db.js';
import { MemoryStore } from '../../src/storage/memory-store.js';
import type { SessionAdapter } from '../../src/types/index.js';
import { withGrantableTestDir, withTempDir } from '../helpers/tmp.js';

const ID = '019fa000-0000-7000-8000-000000000311';

type Seam = { scanFile(adapter: SessionAdapter, filePath: string, closeTrailingOnIdle: boolean): Promise<{ ingested: number }> };

const daemons: IngestionDaemon[] = [];

afterEach(async () => {
    await Promise.all(daemons.splice(0).map((daemon) => daemon.stop()));
    vi.unstubAllEnvs();
});

function line(second: number, type: string, payload: unknown): string {
    return `${JSON.stringify({ timestamp: new Date(Date.UTC(2026, 8, 28) + second * 1000).toISOString(), type, payload })}\n`;
}

// Real Codex records: one turn is a user message and the assistant's reply.
function exchange(second: number): string {
    return (
        line(second, 'response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: `Request ${second}` }] }) +
        line(second + 1, 'response_item', {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: `Answer ${second}` }],
        })
    );
}

// The only declaration of the working directory, surface and branch.
function header(cwd: string): string {
    return line(0, 'session_meta', { id: ID, cwd, originator: 'codex-tui', git: { branch: 'main' } });
}

function harness() {
    const root = withTempDir('codex-resume-capture-');
    vi.stubEnv('CODEX_HOME', path.join(root, '.codex'));
    vi.stubEnv('ELEPHA_HOME', path.join(root, 'elepha-home'));
    mkdirSync(path.join(root, 'elepha-home'), { recursive: true });
    const codexRoot = path.join(root, '.codex', 'sessions');
    const source = path.join(codexRoot, '2026', '09', '28', `rollout-2026-09-28T00-00-00-${ID}.jsonl`);
    mkdirSync(path.dirname(source), { recursive: true });
    const dbPath = path.join(root, 'elepha.db');
    const warnings: string[] = [];
    const logs: string[] = [];
    const open = () => new MemoryStore(openUnmanagedDb(dbPath), { resolveGitRoot: () => null, resolveGitRemote: () => null });
    const checkout = (prefix: string) => realpathSync(withGrantableTestDir(prefix));
    const daemonFor = (store: MemoryStore, resumeContextStep?: { bytes?: number; elapsedMs?: number }) => {
        const daemon = new IngestionDaemon({
            store,
            watchRoots: [codexRoot],
            readConfig: () => ({ config: {} }),
            idleDebounceMs: 5,
            resumeContextStep,
            log: (message) => logs.push(message),
            logError: (message) => logs.push(message),
        });
        daemons.push(daemon);
        return daemon as unknown as Seam & Pick<IngestionDaemon, 'stop'>;
    };
    const adapter = new CodexAdapter((message) => warnings.push(message));
    const scan = async (daemon: Seam) => (await daemon.scanFile(adapter, source, true)).ingested;
    const projects = (store: MemoryStore) =>
        store.database
            .prepare('SELECT p.path FROM memories m JOIN projects p ON p.id = m.project_id ORDER BY m.turn_index')
            .pluck()
            .all() as string[];
    const session = (store: MemoryStore) =>
        store.database.prepare('SELECT cursor, cursor_context FROM sessions WHERE native_id = ?').get(ID) as {
            cursor: string | null;
            cursor_context: string | null;
        };
    return { source, dbPath, warnings, logs, open, checkout, daemonFor, scan, projects, session, adapter };
}

describe('Codex capture resumes with the context its cursor was issued with', () => {
    it('captures appended turns of a header-only session through its stored cursor, including after a restart', async () => {
        const h = harness();
        const cwd = h.checkout('codex-header-only-');
        const store = h.open();
        store.consent.grant(cwd);
        writeFileSync(h.source, header(cwd) + exchange(1));
        const first = h.daemonFor(store);
        expect(await h.scan(first)).toBe(1);
        expect(h.session(store).cursor_context).not.toBeNull();

        appendFileSync(h.source, exchange(3));
        expect(await h.scan(first), h.logs.join('\n')).toBe(1);
        await first.stop();

        const restarted = h.daemonFor(store);
        appendFileSync(h.source, exchange(5));
        expect(await h.scan(restarted), h.logs.join('\n')).toBe(1);
        expect(h.projects(store)).toEqual([cwd, cwd, cwd]);
        expect(h.logs.some((message) => message.includes('outside every approved root'))).toBe(false);
    });

    it('follows a working-directory change and keeps it across a restart', async () => {
        const h = harness();
        const before = h.checkout('codex-context-before-');
        const after = h.checkout('codex-context-after-');
        const store = h.open();
        store.consent.grant(before);
        store.consent.grant(after);
        writeFileSync(h.source, header(before) + exchange(1));
        const first = h.daemonFor(store);
        expect(await h.scan(first)).toBe(1);

        appendFileSync(h.source, line(3, 'turn_context', { cwd: after }) + exchange(3));
        expect(await h.scan(first), h.logs.join('\n')).toBe(1);
        await first.stop();

        const restarted = h.daemonFor(store);
        appendFileSync(h.source, exchange(5));
        expect(await h.scan(restarted), h.logs.join('\n')).toBe(1);
        expect(h.projects(store)).toEqual([before, after, after]);
    });

    it('refuses to resume once the header that set the context is rewritten, without substituting the stored project', async () => {
        const h = harness();
        const cwd = h.checkout('codex-context-rewrite-');
        // Approved too, so only the context check can refuse the read.
        const other = h.checkout('codex-context-rewrite-');
        expect(other.length).toBe(cwd.length);
        const store = h.open();
        store.consent.grant(cwd);
        store.consent.grant(other);
        writeFileSync(h.source, header(cwd) + exchange(1));
        const daemon = h.daemonFor(store);
        expect(await h.scan(daemon)).toBe(1);
        const cursor = h.session(store).cursor;

        // Same inode and size: only the declared working directory changes.
        const size = statSync(h.source).size;
        writeFileSync(h.source, readFileSync(h.source, 'utf8').replace(`"cwd":${JSON.stringify(cwd)}`, `"cwd":${JSON.stringify(other)}`));
        expect(statSync(h.source).size).toBe(size);
        appendFileSync(h.source, exchange(3));

        expect(await h.scan(daemon)).toBe(0);
        expect(h.projects(store)).toEqual([cwd]);
        expect(h.session(store).cursor).toBe(cursor);
        expect(
            h.warnings.some((message) => message.includes('[cursor desync]')),
            [...h.warnings, ...h.logs].join('\n'),
        ).toBe(true);
    });

    it('derives the context once from the source for a cursor stored by the prior schema, then records it', async () => {
        const h = harness();
        const cwd = h.checkout('codex-context-legacy-');
        const store = h.open();
        store.consent.grant(cwd);
        writeFileSync(h.source, header(cwd) + exchange(1));
        const daemon = h.daemonFor(store);
        expect(await h.scan(daemon)).toBe(1);
        const cursor = h.session(store).cursor;
        await daemon.stop();
        store.database.close();

        // The prior schema stored the cursor alone.
        const prior = new Database(h.dbPath);
        prior.exec('ALTER TABLE sessions DROP COLUMN cursor_context');
        prior.close();

        const migrated = h.open();
        expect(h.session(migrated)).toEqual({ cursor, cursor_context: null });
        appendFileSync(h.source, exchange(3));
        const restarted = h.daemonFor(migrated);
        expect(await h.scan(restarted), h.logs.join('\n')).toBe(1);
        expect(h.projects(migrated)).toEqual([cwd, cwd]);
        expect(h.session(migrated).cursor_context).not.toBeNull();
    });

    // A cursor stored by the prior schema deep into a long session, with the
    // column that now records its context dropped.
    async function legacyCursor(h: ReturnType<typeof harness>, history: number) {
        const cwd = h.checkout('codex-context-steps-');
        const store = h.open();
        store.consent.grant(cwd);
        writeFileSync(h.source, header(cwd) + Array.from({ length: history }, (_, i) => exchange(1 + 2 * i)).join(''));
        const daemon = h.daemonFor(store);
        expect(await h.scan(daemon)).toBe(history);
        const cursor = h.session(store).cursor;
        await daemon.stop();
        store.database.close();
        const prior = new Database(h.dbPath);
        prior.exec('ALTER TABLE sessions DROP COLUMN cursor_context');
        prior.close();
        const migrated = h.open();
        appendFileSync(h.source, exchange(1 + 2 * history));
        return { cwd, store: migrated, cursor };
    }

    it('reconstructs a stored cursor context across bounded steps without moving the cursor, then captures once', async () => {
        const h = harness();
        const { cwd, store, cursor } = await legacyCursor(h, 40);
        const steps = vi.spyOn(h.adapter, 'deriveResumeContext');
        const daemon = h.daemonFor(store, { bytes: 6000 });

        // The first step cannot finish: nothing is captured and the cursor stays.
        expect(await h.scan(daemon)).toBe(0);
        expect(h.session(store).cursor).toBe(cursor);
        expect(h.projects(store)).toHaveLength(40);

        // Queued steps continue from their progress until the turn is captured.
        await vi.waitFor(() => expect(h.projects(store), h.logs.join('\n')).toHaveLength(41), { timeout: 5_000 });
        expect(steps.mock.calls.length).toBeGreaterThan(2);
        const resumedFrom = steps.mock.calls.map(([, , options]) => options.from?.offset ?? 0);
        expect(resumedFrom.slice(1).every((offset, i) => offset > resumedFrom[i]!)).toBe(true);
        expect(h.projects(store).at(-1)).toBe(cwd);
        expect(h.session(store).cursor_context).not.toBeNull();

        // Nothing is captured twice.
        expect(await h.scan(daemon)).toBe(0);
        expect(h.projects(store)).toHaveLength(41);
    });

    it('stops reconstructing when the daemon stops and starts it again after a restart, capturing once', async () => {
        const h = harness();
        const { cwd, store, cursor } = await legacyCursor(h, 40);
        const first = h.daemonFor(store, { bytes: 6000 });
        expect(await h.scan(first)).toBe(0);
        await first.stop();
        // A step that runs after the stop reads nothing further and queues nothing.
        expect(await h.scan(first)).toBe(0);
        expect(h.session(store).cursor).toBe(cursor);
        expect(h.projects(store)).toHaveLength(40);

        const restarted = h.daemonFor(store, { bytes: 6000 });
        expect(await h.scan(restarted)).toBe(0);
        await vi.waitFor(() => expect(h.projects(store), h.logs.join('\n')).toHaveLength(41), { timeout: 5_000 });
        expect(h.projects(store).at(-1)).toBe(cwd);
        expect(await h.scan(restarted)).toBe(0);
        expect(h.projects(store)).toHaveLength(41);
    });
});
