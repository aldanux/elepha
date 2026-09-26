import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { HOOK_PAYLOAD_MAX_CHARS } from '../../src/config/constants.js';
import * as common from '../../src/hooks/common.js';
import {
    parseStandingRulesPayload,
    runStandingRulesHook,
    runStandingRulesHookCli,
    type StandingRulesHookDependencies,
} from '../../src/hooks/standing-rules.js';
import { STANDING_RULES_AUTHORITY, STANDING_RULES_INVALID } from '../../src/serving/standing-rules.js';
import { openUnmanagedDb } from '../../src/storage/db.js';
import { MemoryStore } from '../../src/storage/memory-store.js';
import { createTestDb, seedConsentRoot, seedProject } from '../helpers/db.js';

const ISO = '2026-09-20T00:00:00.000Z';

function fixture() {
    const f = createTestDb('elepha-opencode-rules-');
    const cwd = path.join(f.directory, 'project-a');
    mkdirSync(cwd);
    const project = seedProject(f, { path: cwd });
    seedConsentRoot(f, { path: cwd });
    //noinspection JSUnusedGlobalSymbols
    const scope = { projectIds: [project.id], ownerProjectId: project.id, stillConsented: () => true };
    const added = f.store.standingRules.add(scope, 'Use Foo and keep $(syntax) inert.', ISO);
    expect(added.status).toBe('added');
    const rule = f.store.standingRules.list([project.id])[0];
    f.close();
    const run = (sessionId = 'A', directory = cwd, overrides: StandingRulesHookDependencies = {}) =>
        runStandingRulesHook(JSON.stringify({ session_id: sessionId, cwd: directory }), {
            dbPath: f.dbPath,
            now: () => Date.parse(ISO),
            ...overrides,
        });
    const mutate = (operation: (store: MemoryStore) => void) => {
        const db = openUnmanagedDb(f.dbPath);
        try {
            operation(new MemoryStore(db, { resolveGitRoot: () => null, resolveGitRemote: () => null }));
        } finally {
            db.close();
        }
    };
    return { ...f, cwd, scope, rule, run, mutate };
}

function context(result: Awaited<ReturnType<typeof runStandingRulesHook>>): string {
    if (!('context' in result)) throw new Error(result.reason);
    expect(Object.keys(result)).toEqual(['context']);
    expect(result.context).toMatch(/^\[\[elepha:rules:[0-9A-HJKMNP-TV-Z]{26}]]\n/);
    expect(result.context.endsWith('\n[[/elepha]]')).toBe(true);
    return result.context.split('\n').slice(1, -1).join('\n');
}

describe('OpenCode standing-rules transport', () => {
    it.each([
        '',
        '{}',
        '[]',
        'null',
        JSON.stringify({ session_id: '', cwd: '/project' }),
        JSON.stringify({ session_id: ' ', cwd: '/project' }),
        JSON.stringify({ session_id: 1, cwd: '/project' }),
        JSON.stringify({ session_id: 'A', cwd: '' }),
        JSON.stringify({ session_id: 'A', cwd: '/project', source: 'startup' }),
        'x'.repeat(HOOK_PAYLOAD_MAX_CHARS + 1),
    ])('rejects missing, extra or oversized transport fields %#', (raw) => {
        expect(parseStandingRulesPayload(raw)).toBeUndefined();
    });

    it('serves fresh exact rules repeatedly, then observes replacement and removal without notice or cache', async () => {
        const f = fixture();
        const body = `${STANDING_RULES_AUTHORITY}\n- ${f.rule.text}`;
        expect(context(await f.run())).toBe(body);
        expect(context(await f.run())).toBe(body);
        f.mutate((store) => {
            const rows = store.injectionsForSession('opencode', 'A', ISO);
            expect(rows.map((row) => row.body)).toEqual([body]);
            expect(rows[0].body_hash).toMatch(/^exact:[a-f0-9]{64}$/);
            expect(
                store.isInjectionQuoteBack({
                    tool: 'opencode',
                    sessionId: 'A',
                    sourcePath: '',
                    projectPath: f.cwd,
                    turnIndex: 1,
                    startedAt: ISO,
                    endedAt: ISO,
                    userMessage: 'quote',
                    assistantText: body,
                    toolCalls: [],
                    cursor: '1',
                    hasExternalContent: false,
                    resumeMarkerBefore: false,
                }),
            ).toBe(true);
            expect(store.standingRules.replace(f.scope, f.rule.ulid, 'Use foo and keep $(syntax) inert.').status).toBe('replaced');
        });
        const replacement = context(await f.run());
        expect(replacement).not.toBe(body);
        expect(replacement).toContain('Use foo');
        f.mutate((store) => {
            expect(store.injectionsForSession('opencode', 'A', ISO).map((row) => row.body)).toEqual([body, replacement]);
            expect(store.standingRules.remove(f.scope, f.rule.ulid).status).toBe('removed');
        });
        expect(await f.run()).toEqual({ reason: 'no_rules' });
    });

    it('isolates project rules and durable session attribution across A, B, A', async () => {
        const f = fixture();
        const peerPath = path.join(f.directory, 'project-b');
        mkdirSync(peerPath);
        f.mutate((store) => {
            const peer = store.upsertProject(peerPath);
            store.consent.grant(peerPath);
            expect(
                store.standingRules.add(
                    { projectIds: [peer.id], ownerProjectId: peer.id, stillConsented: () => true },
                    'Project B only.',
                    ISO,
                ).status,
            ).toBe('added');
        });
        const a = context(await f.run('A'));
        const b = context(await f.run('B', peerPath));
        expect(context(await f.run('A'))).toBe(a);
        expect(b).toBe(`${STANDING_RULES_AUTHORITY}\n- Project B only.`);
        expect(a).not.toContain('Project B only.');
        f.mutate((store) => {
            expect(store.injectionsForSession('opencode', 'A', ISO).map((row) => row.body)).toEqual([a]);
            expect(store.injectionsForSession('opencode', 'B', ISO).map((row) => row.body)).toEqual([b]);
            expect(store.injectionsForSession('codex', 'A', ISO)).toEqual([]);
        });
    });

    it.each(['revoke', 'lock', 'generation', 'membership', 'invalid'])(
        'fails closed for %s at the fresh transaction boundary',
        async (change) => {
            const f = fixture();
            const logs: string[] = [];
            const result = await f.run('A', f.cwd, {
                log: (line) => logs.push(line),
                beforeDelivery: (db) => {
                    expect(db.inTransaction).toBe(false);
                    if (change === 'revoke') db.exec("UPDATE consent_roots SET state = 'denied'");
                    else if (change === 'lock') db.exec("UPDATE paranoid_authority SET enrolled = 1, state = 'locked'");
                    else if (change === 'generation') db.exec('UPDATE paranoid_authority SET generation = generation + 1');
                    else if (change === 'membership') db.exec("UPDATE projects SET git_remote = 'changed-identity'");
                    else db.exec("UPDATE standing_rules SET text = ''");
                },
            });
            const reason =
                change === 'invalid'
                    ? STANDING_RULES_INVALID
                    : change === 'lock' || change === 'generation'
                      ? 'locked_or_stale'
                      : 'no_rules';
            expect(result).toEqual({ reason });
            expect(logs).toEqual(reason === 'no_rules' ? [] : [`standing-rules opencode: ${reason}`]);
            f.mutate((store) => expect(store.injectionsForSession('opencode', 'A', ISO)).toEqual([]));
        },
    );

    it.each(['false', 'throw'])('rolls back attribution and emits no context when the writer returns %s', async (failure) => {
        const f = fixture();
        const log = vi.fn();
        expect(
            await f.run('A', f.cwd, {
                log,
                writeInjection: (store, input) => {
                    expect(store.database.inTransaction).toBe(true);
                    store.recordInjection(input);
                    if (failure === 'throw') throw new Error('record failure');
                    return false;
                },
            }),
        ).toEqual({ reason: 'injection_record_failed' });
        expect(log).toHaveBeenCalledExactlyOnceWith('standing-rules opencode: injection_record_failed');
        f.mutate((store) => expect(store.injectionsForSession('opencode', 'A', ISO)).toEqual([]));
    });

    it('migrates an existing legacy database but never creates a missing database', async () => {
        const f = fixture();
        const log = vi.fn();
        f.mutate((store) => store.database.exec('DROP TABLE standing_rules'));
        expect(await f.run('private-session', f.cwd, { log })).toEqual({ reason: 'no_rules' });
        expect(log).not.toHaveBeenCalled();
        f.mutate((store) =>
            expect(store.database.prepare("SELECT name FROM sqlite_master WHERE name = 'standing_rules'").get()).toEqual({
                name: 'standing_rules',
            }),
        );
        const missing = path.join(f.directory, 'missing.db');
        expect(await f.run('private-session', f.cwd, { dbPath: missing, log })).toEqual({ reason: 'database_unavailable' });
        expect(existsSync(missing)).toBe(false);
        expect(
            await f.run('private-session', f.cwd, {
                log,
                openDatabase: () => {
                    throw new Error('unreadable');
                },
            }),
        ).toEqual({ reason: 'database_unavailable' });
        expect(log.mock.calls).toEqual([
            ['standing-rules opencode: database_unavailable'],
            ['standing-rules opencode: database_unavailable'],
        ]);
    });

    it('diagnoses malformed transport and unexpected failures without logging payload or exception content', async () => {
        const f = fixture();
        const log = vi.fn();
        expect(
            await runStandingRulesHook(
                JSON.stringify({ session_id: 'private-session', cwd: 'private-directory', prompt: 'private prompt' }),
                { log },
            ),
        ).toEqual({ reason: 'invalid_payload' });
        expect(
            await f.run('private-session', f.cwd, {
                log,
                beforeDelivery: () => {
                    throw new Error('Private exception details.');
                },
            }),
        ).toEqual({ reason: 'hook_error' });
        expect(log.mock.calls).toEqual([['standing-rules opencode: invalid_payload'], ['standing-rules opencode: hook_error']]);
    });

    it('keeps invalid CLI requests silent on stdout', async () => {
        const stdin = vi.spyOn(common, 'readStdin').mockResolvedValue('{}');
        const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
        try {
            await runStandingRulesHookCli();
            expect(stdout).not.toHaveBeenCalled();
        } finally {
            stdin.mockRestore();
            stdout.mockRestore();
        }
    });
});
