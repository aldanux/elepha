import { createHash } from 'node:crypto';
import { mkdirSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CodexAdapter } from '../../src/adapters/codex.js';
import {
    SESSION_KIND_PREAMBLE_MAX_BYTES,
    SESSION_KIND_RECONCILIATION_BATCH_SIZE,
    SESSION_KIND_RECONCILIATION_BUDGET_MS,
    SESSION_KIND_REVISION,
} from '../../src/config/constants.js';
import { openProviderTranscript, type ProviderTranscriptOpener } from '../../src/security/provider-transcript.js';
import { openUnmanagedDb } from '../../src/storage/db.js';
import { reconcileSessionKinds, sessionKindStatus } from '../../src/storage/session-kind-reconciliation.js';
import { createTestDb, seedMemory, seedProject, seedRollup, seedSession } from '../helpers/db.js';

function fixture() {
    const f = createTestDb('elepha-kind-revision-');
    const project = seedProject(f);
    f.store.consent.grant(project.path);
    const codexHome = path.join(f.directory, '.codex');
    const providerRoot = path.join(codexHome, 'sessions');
    mkdirSync(providerRoot, { recursive: true });
    vi.stubEnv('CODEX_HOME', codexHome);
    let next = 0;
    function add(metadata: Record<string, unknown> = {}, turnId = 'native-task') {
        const nativeId = `session-${++next}`;
        const sourcePath = path.join(providerRoot, `rollout-${nativeId}.jsonl`);
        const text = `${[
            JSON.stringify({ type: 'session_meta', payload: { id: nativeId, cwd: project.path, ...metadata } }),
            JSON.stringify({ type: 'event_msg', payload: { type: 'task_started', turn_id: turnId } }),
        ].join('\n')}\n`;
        writeFileSync(sourcePath, text);
        const session = seedSession(f, { project, nativeId, sourcePath, kind: 'main', customTitle: 'Keep me' });
        f.db.prepare('UPDATE sessions SET kind_revision = 0 WHERE id = ?').run(session.id);
        return { session, sourcePath, text, nativeId };
    }
    return { ...f, project, providerRoot, add };
}

describe('versioned session classification reconciliation', () => {
    afterEach(() => vi.unstubAllEnvs());

    it('expands a real previous database and preserves rows on idempotent reopen', () => {
        const f = fixture();
        const { session } = f.add();
        expect(
            (f.db.pragma('table_info(sessions)') as Array<Record<string, unknown>>).find((column) => column.name === 'kind_revision'),
        ).toMatchObject({ type: 'INTEGER', notnull: 1, dflt_value: '0' });
        f.db.exec('ALTER TABLE sessions DROP COLUMN kind_revision');
        const before = f.db.prepare('SELECT * FROM sessions').all();
        f.close();
        const migrated = openUnmanagedDb(f.dbPath);
        const row = migrated.prepare('SELECT * FROM sessions').get() as Record<string, unknown>;
        const { kind_revision, ...preserved } = row;
        expect(kind_revision).toBe(0);
        expect([preserved]).toEqual(before);
        migrated.prepare('UPDATE sessions SET kind_revision = ? WHERE id = ?').run(SESSION_KIND_REVISION, session.id);
        migrated.close();
        const reopened = openUnmanagedDb(f.dbPath);
        expect(reopened.prepare('SELECT kind_revision FROM sessions').get()).toEqual({ kind_revision: SESSION_KIND_REVISION });
        reopened.close();
    });

    it('updates only kind and revision across historical segments and preserves all content and vectors', async () => {
        const f = fixture();
        const guardian = f.add({ thread_source: 'guardian_review', source: { subagent: { other: 'guardian' } } });
        const main = f.add();
        const segment = f.store.startNextSegment(guardian.session, f.project.id, guardian.sourcePath, { kind: 'main' });
        f.db.prepare('UPDATE sessions SET kind_revision = 0 WHERE id = ?').run(segment.id);
        const memory = seedMemory(f, { project: f.project, session: guardian.session });
        seedRollup(f, { project: f.project, session: guardian.session });
        f.db
            .prepare(`INSERT INTO filtered_turns (memory_id, included, user_prompt, assistant_response, tool_calls, filter_version, captured_at)
            VALUES (?, 1, 'keep prompt', 'keep response', '[]', 1, 'before')`)
            .run(memory.id);
        f.db
            .prepare(`INSERT INTO session_embeddings
            (session_id, rollup_session_id, project_id, source_hash, model, model_revision, dimensions, vector, computed_at)
            VALUES (?, ?, ?, 'hash', 'model', 'rev', 1, ?, 'before')`)
            .run(guardian.session.id, guardian.session.id, f.project.id, Buffer.from([0, 0, 128, 63]));
        const snapshot = () =>
            ['memories', 'filtered_turns', 'session_rollups', 'session_embeddings', 'projects', 'durable_capture_usage'].map((table) =>
                createHash('sha256')
                    .update(JSON.stringify(f.db.prepare(`SELECT * FROM ${table}`).all()))
                    .digest('hex'),
            );
        const before = snapshot();
        const rows = f.db.prepare('SELECT * FROM sessions ORDER BY id').all() as Array<Record<string, unknown>>;
        const log = vi.fn();
        expect(await reconcileSessionKinds(f.store, { log })).toEqual({
            checked: 3,
            reclassified: 2,
            pending: 0,
            incidents: 0,
            malformed: 0,
        });
        expect(snapshot()).toEqual(before);
        expect(f.db.prepare('SELECT * FROM sessions ORDER BY id').all()).toEqual(
            rows.map((row) => ({
                ...row,
                kind: row.id === main.session.id ? 'main' : 'adjudicator',
                kind_revision: SESSION_KIND_REVISION,
            })),
        );
        expect(log).toHaveBeenCalledOnce();
        const opener = vi.fn(openProviderTranscript);
        await reconcileSessionKinds(f.store, { openTranscript: opener });
        expect(opener).not.toHaveBeenCalled();
        expect(sessionKindStatus(f.db)).toEqual({ pending: 0, incidents: 0, updating: false });
    });

    it.each([
        [{ thread_source: 'subagent' }, 'native', 'adjudicator'],
        [{ source: { subagent: { other: 'guardian' } } }, 'native', 'adjudicator'],
        [{ thread_source: 'subagent', agent_path: '/root/review', agent_nickname: 'Reviewer' }, 'native', 'main'],
        [{ thread_source: 'guardian_review', forked_from_id: 'parent' }, 'native', 'main'],
        [{ thread_source: 'guardian_review' }, 'external-import-turn-1', 'main'],
    ] as const)('respects classification precedence for %j', async (metadata, turnId, kind) => {
        const f = fixture();
        const { session } = f.add(metadata, turnId);
        await reconcileSessionKinds(f.store);
        expect(f.db.prepare('SELECT kind, kind_revision FROM sessions WHERE id = ?').get(session.id)).toEqual({
            kind,
            kind_revision: SESSION_KIND_REVISION,
        });
    });

    it.each([
        [{ thread_source: 'guardian_review', forked_from_id: {} }, 'adjudicator'],
        [{ forked_from_id: {} }, 'primary'],
        [{ thread_source: 'subagent', agent_path: {}, agent_nickname: 7 }, 'adjudicator'],
        [{ thread_source: 'subagent', agent_path: {}, agent_nickname: 'Reviewer' }, 'subagent'],
        [{ source: { subagent: { other: ['guardian'] } } }, 'primary'],
    ] as const)('shares defensive optional-discriminator behavior with live ingestion: %j', async (metadata, kind) => {
        const f = fixture();
        const source = f.add(metadata);
        const liveWarning = vi.fn();
        expect((await new CodexAdapter(liveWarning).classifySession(source.sourcePath)).kind).toBe(kind);
        expect(liveWarning).toHaveBeenCalledOnce();
        const warn = vi.fn();
        expect(await reconcileSessionKinds(f.store, { warn })).toMatchObject({ checked: 1, pending: 0, malformed: 1 });
        expect(warn).toHaveBeenCalledOnce();
        expect(f.db.prepare('SELECT kind, kind_revision FROM sessions').get()).toEqual({
            kind: kind === 'adjudicator' ? 'adjudicator' : 'main',
            kind_revision: SESSION_KIND_REVISION,
        });
    });

    it.each([{}, { thread_source: 'guardian_review', forked_from_id: 'parent' }])(
        'acknowledges an ordinary or fork header without requiring event records: %j',
        async (metadata) => {
            const f = fixture();
            const source = f.add(metadata);
            writeFileSync(source.sourcePath, `${source.text.split('\n')[0]}\nnot JSON; response-item-only history follows`);
            expect(await reconcileSessionKinds(f.store)).toMatchObject({ checked: 1, reclassified: 0, pending: 0 });
        },
    );

    it('authorizes segments independently when a transcript changes project cwd', async () => {
        const f = fixture();
        const source = f.add({ thread_source: 'guardian_review' });
        const secondProject = seedProject(f, { path: path.join(f.directory, 'second-project') });
        const revokedProject = seedProject(f, { path: path.join(f.directory, 'revoked-project') });
        f.store.consent.grant(secondProject.path);
        const second = f.store.startNextSegment(source.session, secondProject.id, source.sourcePath, { kind: 'main' });
        const third = f.store.startNextSegment(second, revokedProject.id, source.sourcePath, { kind: 'main' });
        f.db.prepare('UPDATE sessions SET kind_revision = 0 WHERE id IN (?, ?)').run(second.id, third.id);
        expect(await reconcileSessionKinds(f.store)).toMatchObject({ checked: 2, reclassified: 2, pending: 1, incidents: 1 });
        expect(f.db.prepare('SELECT id, kind, kind_revision FROM sessions ORDER BY id').all()).toEqual([
            { id: source.session.id, kind: 'adjudicator', kind_revision: SESSION_KIND_REVISION },
            { id: second.id, kind: 'adjudicator', kind_revision: SESSION_KIND_REVISION },
            { id: third.id, kind: 'main', kind_revision: 0 },
        ]);
        f.store.consent.grant(revokedProject.path);
        expect(await reconcileSessionKinds(f.store)).toMatchObject({ checked: 1, reclassified: 1, pending: 0 });
    });

    it('does not consume a second record when the header cwd is unapproved', async () => {
        const f = fixture();
        const source = f.add({ thread_source: 'guardian_review' });
        const header = source.text.split('\n')[0]?.replace(f.project.path, path.join(f.directory, 'unapproved-project'));
        // Buffered bytes may include the malformed second record; its content
        // must never be interpreted before the original cwd is authorized.
        writeFileSync(source.sourcePath, `${header}\n{malformed second record\n`);
        const warn = vi.fn();
        expect(await reconcileSessionKinds(f.store, { warn })).toMatchObject({ checked: 0, pending: 1 });
        expect(warn.mock.calls[0]?.[0]).toContain('session metadata cwd is not currently authorized');
    });

    it.each(['missing', 'malformed', 'oversized', 'no-boundary', 'native-mismatch', 'cwd-relative', 'outside-symlink'])(
        'keeps %s pending and retries successfully after restoration',
        async (failure) => {
            const f = fixture();
            const source = f.add({ thread_source: 'guardian_review' });
            const backup = `${source.sourcePath}.saved`;
            if (failure === 'missing' || failure === 'outside-symlink') renameSync(source.sourcePath, backup);
            if (failure === 'malformed') writeFileSync(source.sourcePath, '{broken\n');
            if (failure === 'oversized') writeFileSync(source.sourcePath, 'x'.repeat(SESSION_KIND_PREAMBLE_MAX_BYTES + 1));
            if (failure === 'no-boundary') writeFileSync(source.sourcePath, `${source.text.split('\n')[0]}\n`);
            if (failure === 'native-mismatch') writeFileSync(source.sourcePath, source.text.replace(source.nativeId, 'different'));
            if (failure === 'cwd-relative') writeFileSync(source.sourcePath, source.text.replace(f.project.path, 'relative-project'));
            if (failure === 'outside-symlink') {
                const outside = path.join(f.directory, 'outside.jsonl');
                writeFileSync(outside, source.text);
                symlinkSync(outside, source.sourcePath);
            }
            const warn = vi.fn();
            expect(await reconcileSessionKinds(f.store, { warn })).toMatchObject({ checked: 0, pending: 1, incidents: 1 });
            expect(sessionKindStatus(f.db)).toEqual({ pending: 1, incidents: 1, updating: false });
            expect(warn.mock.calls[0]?.[0]).toContain(source.sourcePath);
            expect(f.db.prepare('SELECT kind, kind_revision FROM sessions').get()).toEqual({ kind: 'main', kind_revision: 0 });
            if (failure === 'outside-symlink') renameSync(source.sourcePath, `${source.sourcePath}.rejected-link`);
            writeFileSync(source.sourcePath, source.text);
            expect(await reconcileSessionKinds(f.store)).toMatchObject({ reclassified: 1, pending: 0 });
        },
    );

    it.each(['inode', 'size', 'row', 'generation', 'revoke', 'purge', 'incognito'])(
        'rechecks %s changes after opening and leaves classification pending',
        async (change) => {
            const f = fixture();
            const source = f.add({ thread_source: 'guardian_review' });
            let readCalls = () => 0;
            const opener: ProviderTranscriptOpener = async (tool, sourcePath) => {
                const opened = await openProviderTranscript(tool, sourcePath);
                if (!('reason' in opened)) {
                    const read = vi.spyOn(opened.handle, 'read');
                    readCalls = () => read.mock.calls.length;
                }
                if (change === 'inode') {
                    renameSync(sourcePath, `${sourcePath}.old`);
                    writeFileSync(sourcePath, source.text);
                }
                if (change === 'size') writeFileSync(sourcePath, `${source.text}{}\n`);
                if (change === 'row') f.db.prepare('UPDATE sessions SET title = ? WHERE id = ?').run('concurrent title', source.session.id);
                if (change === 'generation') f.db.prepare('INSERT INTO source_generations VALUES (?, ?, 1)').run('codex', source.nativeId);
                if (change === 'revoke') f.store.consent.revoke(f.project.path);
                if (change === 'purge')
                    f.db.prepare('INSERT INTO purged_transcripts VALUES (?, ?, ?)').run('codex', source.nativeId, 'now');
                if (change === 'incognito') f.store.recordIncognitoTranscript('codex', source.nativeId);
                return opened;
            };
            expect(await reconcileSessionKinds(f.store, { openTranscript: opener })).toMatchObject({
                checked: 0,
                pending: 1,
                incidents: 1,
            });
            expect(f.db.prepare('SELECT kind, kind_revision FROM sessions').get()).toEqual({ kind: 'main', kind_revision: 0 });
            if (change === 'revoke') {
                expect(readCalls()).toBe(0);
                f.store.consent.grant(f.project.path);
                expect(await reconcileSessionKinds(f.store)).toMatchObject({ reclassified: 1, pending: 0 });
            }
        },
    );

    it('reads a bounded preamble without parsing a huge malformed body', async () => {
        const f = fixture();
        const source = f.add({ thread_source: 'guardian_review' });
        writeFileSync(source.sourcePath, source.text + 'malformed body'.repeat(SESSION_KIND_PREAMBLE_MAX_BYTES));
        let bytesRead = 0;
        const opener: ProviderTranscriptOpener = async (tool, sourcePath) => {
            const result = await openProviderTranscript(tool, sourcePath);
            if ('reason' in result) return result;
            const read = result.handle.read.bind(result.handle);
            vi.spyOn(result.handle, 'read').mockImplementation(async (...args: Parameters<typeof read>) => {
                const value = await read(...args);
                bytesRead += value.bytesRead;
                return value;
            });
            return result;
        };
        expect(await reconcileSessionKinds(f.store, { openTranscript: opener })).toMatchObject({ reclassified: 1, pending: 0 });
        expect(bytesRead).toBeLessThanOrEqual(SESSION_KIND_PREAMBLE_MAX_BYTES);
    });

    it('yields between bounded batches and leaves unvisited rows pending on cancellation or deadline', async () => {
        const f = fixture();
        for (let i = 0; i <= SESSION_KIND_RECONCILIATION_BATCH_SIZE; i++) f.add({ thread_source: 'guardian_review' });
        let stop = false;
        const yieldBatch = vi.fn(async () => {
            stop = true;
        });
        expect(await reconcileSessionKinds(f.store, { stopped: () => stop, yieldBatch })).toMatchObject({
            checked: SESSION_KIND_RECONCILIATION_BATCH_SIZE,
            pending: 1,
        });
        expect(yieldBatch).toHaveBeenCalledOnce();
        let clock = 0;
        const opener: ProviderTranscriptOpener = async (tool, sourcePath) => {
            clock += SESSION_KIND_RECONCILIATION_BUDGET_MS;
            return openProviderTranscript(tool, sourcePath);
        };
        // The deadline is checked between sources; the already opened bounded
        // preamble completes atomically and does not strand half-updated rows.
        expect(await reconcileSessionKinds(f.store, { now: () => clock, openTranscript: opener })).toMatchObject({
            checked: 1,
            pending: 0,
        });
        f.add();
        const noOpen = vi.fn(openProviderTranscript);
        expect(await reconcileSessionKinds(f.store, { stopped: () => true, openTranscript: noOpen })).toMatchObject({ pending: 1 });
        expect(noOpen).not.toHaveBeenCalled();
    });
});
