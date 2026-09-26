import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { STANDING_RULES_MAX_ACTIVE, STANDING_RULES_MAX_TOTAL_CHARS } from '../../src/config/constants.js';
import type { HookSource } from '../../src/hooks/common.js';
import { runSessionStart, type SessionStartDependencies } from '../../src/hooks/session-start.js';
import { runUserPromptSubmit } from '../../src/hooks/user-prompt-submit.js';
import * as subprocess from '../../src/security/subprocess-allowlist.js';
import {
    SESSION_RULES_AUTHORITY,
    SESSION_RULES_INVALID,
    STANDING_RULES_AUTHORITY,
    STANDING_RULES_INVALID,
} from '../../src/serving/standing-rules.js';
import { ConsentStore } from '../../src/storage/consent-store.js';
import { openUnmanagedDb } from '../../src/storage/db.js';
import { MemoryStore } from '../../src/storage/memory-store.js';
import { SessionRulesStore } from '../../src/storage/session-rules-store.js';
import { createTestDb, seedConsentRoot, seedProject } from '../helpers/db.js';
import { fixtureGitEnv } from '../helpers/git.js';
import { withGrantableTestDir } from '../helpers/tmp.js';

const NOW = Date.parse('2026-09-20T00:00:00.000Z');
const ISO = new Date(NOW).toISOString();
const QUIET: SessionStartDependencies = {
    now: () => NOW,
    daemonHealth: () => ({ state: 'RUNNING', healthy: true }),
    readUpdateAvailable: () => undefined,
};

function fixture(texts = ['Use Foo.', 'Keep shell references such as $(example) inert.']) {
    const f = createTestDb('elepha-session-rules-');
    const cwd = path.join(f.directory, 'project');
    fs.mkdirSync(cwd);
    const project = seedProject(f, { path: cwd });
    seedConsentRoot(f, { path: cwd });
    for (const text of texts) {
        expect(
            f.store.standingRules.add({ projectIds: [project.id], ownerProjectId: project.id, stillConsented: () => true }, text, ISO)
                .status,
        ).toBe('added');
    }
    const rules = f.store.standingRules.list([project.id]);
    f.close();
    return { ...f, cwd, project, rules };
}

function payload(cwd: string, source: HookSource = 'startup', sessionId = 'rules-chat'): string {
    return JSON.stringify({
        session_id: sessionId,
        cwd,
        hook_event_name: 'SessionStart',
        source,
        model: 'test',
        permission_mode: 'default',
    });
}

function addChatRule(dbPath: string, projectId: number, cwd: string, tool: 'claude-code' | 'codex' | 'opencode', text: string): void {
    const db = openUnmanagedDb(dbPath);
    try {
        expect(
            new SessionRulesStore(db).add(
                {
                    identity: { tool, nativeSessionId: 'rules-chat', checkoutAnchor: cwd },
                    projectIds: [projectId],
                    ownerProjectId: projectId,
                    stillAuthorized: () => true,
                },
                text,
                ISO,
            ).status,
        ).toBe('added');
    } finally {
        db.close();
    }
}

function channels(result: Awaited<ReturnType<typeof runSessionStart>>) {
    if (!('output' in result)) throw new Error(result.reason);
    return {
        rules: (result.output.hookSpecificOutput as { additionalContext?: string }).additionalContext,
        notice: result.output.systemMessage,
    };
}

function unwrapped(text: string, kind: 'rules' | 'notify'): string {
    expect(text).toMatch(new RegExp(`^\\[\\[elepha:${kind}:[0-9A-Z]{26}]]\\n`));
    expect(text.endsWith('\n[[/elepha]]')).toBe(true);
    return text.split('\n').slice(1, -1).join('\n');
}

function records(dbPath: string) {
    const db = openUnmanagedDb(dbPath);
    try {
        return new MemoryStore(db).injectionsForSession('codex', 'rules-chat', ISO);
    } finally {
        db.close();
    }
}

describe('SessionStart standing rules', () => {
    for (const tool of ['claude-code', 'codex'] as const) {
        it(`keeps ${tool} child SessionStart output out of the parent's session`, async () => {
            const f = fixture(['Parent rule.']);
            addChatRule(f.dbPath, f.project.id, f.cwd, tool, 'Parent chat rule.');
            const openDatabase = vi.fn(async (dbPath: string) => openUnmanagedDb(dbPath));
            const daemonHealth = vi.fn(() => ({ state: 'STUCK' as const, healthy: false }));
            const readUpdateAvailable = vi.fn(() => ({ version: '99.0.0', checkedAt: ISO }));
            const writeInjection = vi.fn();
            const dependencies: SessionStartDependencies = {
                dbPath: f.dbPath,
                now: () => NOW,
                openDatabase: openDatabase as unknown as SessionStartDependencies['openDatabase'],
                daemonHealth,
                readUpdateAvailable,
                writeInjection,
            };
            const parent = JSON.parse(payload(f.cwd)) as Record<string, unknown>;

            expect(
                await runSessionStart(JSON.stringify({ ...parent, agent_id: 'agent-child', agent_type: 'Explore' }), tool, dependencies),
            ).toEqual({ reason: 'subagent_context' });
            expect(openDatabase).not.toHaveBeenCalled();
            expect(daemonHealth).not.toHaveBeenCalled();
            expect(readUpdateAvailable).not.toHaveBeenCalled();
            expect(writeInjection).not.toHaveBeenCalled();

            const db = openUnmanagedDb(f.dbPath);
            expect(db.prepare('SELECT body FROM injections WHERE tool = ? AND native_session_id = ?').all(tool, 'rules-chat')).toEqual([]);
            db.close();

            const result = channels(
                await runSessionStart(JSON.stringify({ ...parent, agent_type: 'custom-main-agent' }), tool, {
                    ...dependencies,
                    writeInjection: undefined,
                }),
            );
            expect(result.rules).toContain('Parent rule.');
            expect(result.rules).toContain('Parent chat rule.');
            expect(result.notice).toContain('capture may be stalled');
            expect(openDatabase).toHaveBeenCalledTimes(1);

            const recorded = openUnmanagedDb(f.dbPath);
            const bodies = recorded
                .prepare('SELECT body FROM injections WHERE tool = ? AND native_session_id = ?')
                .all(tool, 'rules-chat') as Array<{
                body: string;
            }>;
            expect(bodies).toHaveLength(2);
            expect(bodies.map(({ body }) => body)).toContain(unwrapped(result.rules ?? '', 'rules'));
            if (typeof result.notice !== 'string') throw new Error('notice missing');
            expect(bodies.map(({ body }) => body)).toContain(unwrapped(result.notice ?? '', 'notify'));
            recorded.close();
        });
    }

    it.each(['approved', 'denied'] as const)('binds all same-remote checkouts and handles a %s peer', async (peerConsent) => {
        const f = fixture(['First checkout rule.']);
        const peerPath = path.join(f.directory, 'second-checkout');
        fs.mkdirSync(peerPath);
        const db = openUnmanagedDb(f.dbPath);
        const store = new MemoryStore(db, { resolveGitRoot: () => null, resolveGitRemote: () => null });
        const peer = store.upsertProject(peerPath);
        db.prepare('UPDATE projects SET git_remote = ?').run('https://example.test/shared-repository');
        const consent = new ConsentStore(db);
        consent.grant(peerPath);
        expect(
            store.standingRules.add(
                { projectIds: [f.project.id, peer.id], ownerProjectId: peer.id, stillConsented: () => true },
                'Second checkout rule.',
                ISO,
            ).status,
        ).toBe('added');
        if (peerConsent === 'denied') db.prepare("UPDATE consent_roots SET state = 'denied' WHERE path = ?").run(peerPath);
        db.close();
        const result = await runSessionStart(payload(f.cwd), 'codex', { ...QUIET, dbPath: f.dbPath });
        if (peerConsent === 'denied') {
            expect(result).toEqual({ reason: 'no_notice' });
            expect(records(f.dbPath)).toEqual([]);
        } else {
            const expected = `${STANDING_RULES_AUTHORITY}\n- First checkout rule.\n- Second checkout rule.`;
            expect(unwrapped(channels(result).rules ?? '', 'rules')).toBe(expected);
            const fromPeer = await runSessionStart(payload(peerPath), 'codex', { ...QUIET, dbPath: f.dbPath });
            expect(unwrapped(channels(fromPeer).rules ?? '', 'rules')).toBe(expected);
            expect(records(f.dbPath).map(({ body }) => body)).toEqual([expected]);
        }
    });

    it('binds chat rules to the caller physical Git checkout, not the logical project representative', async () => {
        const directory = withGrantableTestDir('elepha-session-rules-checkouts-');
        const firstPath = path.join(directory, 'first');
        const secondPath = path.join(directory, 'second');
        for (const checkout of [firstPath, secondPath]) {
            fs.mkdirSync(checkout);
            execFileSync('git', ['-c', 'init.templateDir=/dev/null', 'init', '-q', checkout], { env: fixtureGitEnv() });
        }
        const f = createTestDb('elepha-session-rules-checkouts-db-');
        const first = seedProject(f, { path: firstPath });
        const second = seedProject(f, { path: secondPath });
        f.db.prepare('UPDATE projects SET git_remote = ? WHERE id IN (?, ?)').run('https://example.test/shared', first.id, second.id);
        seedConsentRoot(f, { path: firstPath });
        seedConsentRoot(f, { path: secondPath });
        expect(
            f.store.standingRules.add(
                { projectIds: [first.id, second.id], ownerProjectId: first.id, stillConsented: () => true },
                'Shared project rule.',
                ISO,
            ).status,
        ).toBe('added');
        f.close();
        addChatRule(f.dbPath, first.id, firstPath, 'codex', 'First checkout only.');
        const firstOutput = channels(await runSessionStart(payload(firstPath), 'codex', { ...QUIET, dbPath: f.dbPath }));
        expect(unwrapped(firstOutput.rules ?? '', 'rules')).toBe(
            `${STANDING_RULES_AUTHORITY}\n- Shared project rule.\n\n${SESSION_RULES_AUTHORITY}\n- First checkout only.`,
        );
        const secondOutput = channels(await runSessionStart(payload(secondPath), 'codex', { ...QUIET, dbPath: f.dbPath }));
        expect(unwrapped(secondOutput.rules ?? '', 'rules')).toBe(`${STANDING_RULES_AUTHORITY}\n- Shared project rule.`);
    });

    it('delivers a first-use rootless chat rule from nested cwd in the same checkout', async () => {
        const first = createTestDb('elepha-session-rules-first-chat-db-');
        const projectPath = withGrantableTestDir('elepha-session-rules-first-chat-');
        const nested = path.join(projectPath, 'nested');
        fs.mkdirSync(nested);
        seedConsentRoot(first, { path: projectPath });
        first.close();
        const added = await runUserPromptSubmit(
            JSON.stringify({
                session_id: 'rules-chat',
                cwd: projectPath,
                hook_event_name: 'UserPromptSubmit',
                prompt: 'elepha:rules:session:add Keep this chat in this checkout.',
                model: 'test',
                permission_mode: 'default',
            }),
            'codex',
            { dbPath: first.dbPath, now: () => NOW },
        );
        expect(added).toHaveProperty('output');
        const result = channels(await runSessionStart(payload(nested, 'resume'), 'codex', { ...QUIET, dbPath: first.dbPath }));
        expect(unwrapped(result.rules ?? '', 'rules')).toBe(`${SESSION_RULES_AUTHORITY}\n- Keep this chat in this checkout.`);
        const other = await runSessionStart(payload(nested, 'startup', 'other-chat'), 'codex', { ...QUIET, dbPath: first.dbPath });
        expect(other).toEqual({ reason: 'no_notice' });
    });

    it('delivers rules with an approved same-identity worktree missing from disk', async () => {
        const f = fixture(['Preserve the live checkout rule.']);
        const retiredPath = path.join(f.directory, 'retired-worktree');
        const db = openUnmanagedDb(f.dbPath);
        const store = new MemoryStore(db, { resolveGitRoot: () => null, resolveGitRemote: () => null });
        const retired = store.upsertProject(retiredPath);
        db.prepare('UPDATE projects SET git_remote = ? WHERE id IN (?, ?)').run('https://example.test/shared', f.project.id, retired.id);
        new ConsentStore(db).grant(f.directory);
        expect(fs.existsSync(retiredPath)).toBe(false);
        db.close();

        const result = channels(await runSessionStart(payload(f.cwd), 'codex', { ...QUIET, dbPath: f.dbPath }));
        expect(unwrapped(result.rules ?? '', 'rules')).toBe(`${STANDING_RULES_AUTHORITY}\n- Preserve the live checkout rule.`);
        expect(records(f.dbPath).map(({ body }) => body)).toEqual([`${STANDING_RULES_AUTHORITY}\n- Preserve the live checkout rule.`]);
    });

    it('does not choose among ambiguous consented logical projects', async () => {
        const f = createTestDb('elepha-ambiguous-session-rules-');
        seedConsentRoot(f, { path: f.directory });
        for (const name of ['first', 'second']) {
            const cwd = path.join(f.directory, name);
            fs.mkdirSync(cwd);
            const project = seedProject(f, { path: cwd });
            f.db.prepare('UPDATE projects SET git_remote = ? WHERE id = ?').run(`https://example.test/${name}`, project.id);
            f.store.standingRules.add(
                { projectIds: [project.id], ownerProjectId: project.id, stillConsented: () => true },
                `Private ${name} rule.`,
                ISO,
            );
        }
        f.close();
        expect(await runSessionStart(payload(f.directory), 'codex', { ...QUIET, dbPath: f.dbPath })).toEqual({ reason: 'no_notice' });
        expect(records(f.dbPath)).toEqual([]);
    });

    it('authorizes a rootless stored symlink through its canonical consent binding', async () => {
        const f = fixture(['Preserve this exact rule.']);
        const alias = path.join(f.directory, 'alias');
        fs.symlinkSync(f.cwd, alias);
        const db = openUnmanagedDb(f.dbPath);
        db.prepare('UPDATE projects SET path = ? WHERE id = ?').run(alias, f.project.id);
        db.close();
        const result = channels(await runSessionStart(payload(alias), 'codex', { ...QUIET, dbPath: f.dbPath }));
        expect(unwrapped(result.rules ?? '', 'rules')).toBe(`${STANDING_RULES_AUTHORITY}\n- Preserve this exact rule.`);
    });

    it('delivers a first-use rule inside a consented Git subdirectory without exposing it at the unconsented root', async () => {
        const directory = withGrantableTestDir('elepha-session-rules-subdir-');
        const repo = path.join(directory, 'repo');
        const child = path.join(repo, 'allowed');
        const nested = path.join(child, 'nested');
        fs.mkdirSync(nested, { recursive: true });
        execFileSync('git', ['-c', 'init.templateDir=/dev/null', 'init', '-q', repo], { env: fixtureGitEnv() });
        const f = createTestDb('elepha-session-rules-subdir-db-');
        seedConsentRoot(f, { path: child });
        f.close();

        const added = await runUserPromptSubmit(
            JSON.stringify({
                session_id: 'rules-add-chat',
                cwd: child,
                hook_event_name: 'UserPromptSubmit',
                prompt: 'elepha:rules:add Stay inside the approved directory.',
                model: 'test',
                permission_mode: 'default',
            }),
            'codex',
            { dbPath: f.dbPath, now: () => NOW },
        );
        expect(added).toHaveProperty('output');

        const result = channels(await runSessionStart(payload(child), 'codex', { ...QUIET, dbPath: f.dbPath }));
        expect(unwrapped(result.rules ?? '', 'rules')).toBe(`${STANDING_RULES_AUTHORITY}\n- Stay inside the approved directory.`);
        expect(await runSessionStart(payload(repo), 'codex', { ...QUIET, dbPath: f.dbPath })).toEqual({ reason: 'no_notice' });
        expect(records(f.dbPath).map(({ body }) => body)).toEqual([`${STANDING_RULES_AUTHORITY}\n- Stay inside the approved directory.`]);

        // Capture can later add a Git-root project row while the grant stays
        // limited to the child; that row must not displace the rule owner.
        const db = openUnmanagedDb(f.dbPath);
        new MemoryStore(db).upsertProject(repo);
        db.close();
        const afterCapture = channels(await runSessionStart(payload(child), 'codex', { ...QUIET, dbPath: f.dbPath }));
        expect(unwrapped(afterCapture.rules ?? '', 'rules')).toBe(`${STANDING_RULES_AUTHORITY}\n- Stay inside the approved directory.`);
        const fromNested = channels(await runSessionStart(payload(nested), 'codex', { ...QUIET, dbPath: f.dbPath }));
        expect(unwrapped(fromNested.rules ?? '', 'rules')).toBe(`${STANDING_RULES_AUTHORITY}\n- Stay inside the approved directory.`);
        expect(await runSessionStart(payload(repo), 'codex', { ...QUIET, dbPath: f.dbPath })).toEqual({ reason: 'no_notice' });
    });

    it('adds and delivers a child-only rule after capture already created an unconsented Git-root project row', async () => {
        const directory = withGrantableTestDir('elepha-session-rules-prior-capture-');
        const repo = path.join(directory, 'repo');
        const child = path.join(repo, 'allowed');
        fs.mkdirSync(child, { recursive: true });
        execFileSync('git', ['-c', 'init.templateDir=/dev/null', 'init', '-q', repo], { env: fixtureGitEnv() });
        const f = createTestDb('elepha-session-rules-prior-capture-db-');
        seedConsentRoot(f, { path: child });
        expect(new MemoryStore(f.db).upsertProject(child).path).toBe(repo);
        f.close();

        const rootProbe = vi.spyOn(subprocess, 'gitRevParseShowToplevel');
        let added: Awaited<ReturnType<typeof runUserPromptSubmit>>;
        try {
            added = await runUserPromptSubmit(
                JSON.stringify({
                    session_id: 'rules-add-chat',
                    cwd: child,
                    hook_event_name: 'UserPromptSubmit',
                    prompt: 'elepha:rules:add Respect the approved child.',
                    model: 'test',
                    permission_mode: 'default',
                }),
                'codex',
                { dbPath: f.dbPath, now: () => NOW },
            );
            expect(rootProbe).toHaveBeenCalled();
            expect(rootProbe.mock.calls.every(([cwd]) => cwd === child)).toBe(true);
        } finally {
            rootProbe.mockRestore();
        }
        expect(added).toHaveProperty('output');
        const db = openUnmanagedDb(f.dbPath);
        expect(db.prepare('SELECT path, git_root FROM projects ORDER BY path').all()).toEqual(
            [
                { path: repo, git_root: repo },
                { path: child, git_root: null },
            ].sort((a, b) => a.path.localeCompare(b.path)),
        );
        db.close();
        const deliveryProbe = vi.spyOn(subprocess, 'gitRevParseShowToplevel');
        let delivered: Awaited<ReturnType<typeof runSessionStart>>;
        try {
            delivered = await runSessionStart(payload(child), 'codex', { ...QUIET, dbPath: f.dbPath });
            expect(deliveryProbe).toHaveBeenCalled();
            expect(deliveryProbe.mock.calls.every(([cwd]) => cwd === child)).toBe(true);
        } finally {
            deliveryProbe.mockRestore();
        }
        const result = channels(delivered);
        expect(unwrapped(result.rules ?? '', 'rules')).toBe(`${STANDING_RULES_AUTHORITY}\n- Respect the approved child.`);
        expect(await runSessionStart(payload(repo), 'codex', { ...QUIET, dbPath: f.dbPath })).toEqual({ reason: 'no_notice' });

        const denied = openUnmanagedDb(f.dbPath);
        new ConsentStore(denied).revoke(repo);
        denied.close();
        const deniedProbe = vi.spyOn(subprocess, 'gitRevParseShowToplevel');
        try {
            expect(await runSessionStart(payload(child), 'codex', { ...QUIET, dbPath: f.dbPath })).toEqual({ reason: 'no_notice' });
            expect(deniedProbe.mock.calls.every(([cwd]) => cwd === child)).toBe(true);
        } finally {
            deniedProbe.mockRestore();
        }
        await runUserPromptSubmit(
            JSON.stringify({
                session_id: 'rules-add-after-denial',
                cwd: child,
                hook_event_name: 'UserPromptSubmit',
                prompt: 'elepha:rules:add Do not save after root denial.',
                model: 'test',
                permission_mode: 'default',
            }),
            'codex',
            { dbPath: f.dbPath, now: () => NOW },
        );
        const afterDenial = openUnmanagedDb(f.dbPath);
        expect((afterDenial.prepare('SELECT text FROM standing_rules').all() as Array<{ text: string }>).map((row) => row.text)).toEqual([
            'Respect the approved child.',
        ]);
        afterDenial.close();
    });

    for (const tool of ['claude-code', 'codex'] as const) {
        const sources: HookSource[] = ['startup', 'resume', 'clear', 'compact', ...(tool === 'claude-code' ? ['fork' as const] : [])];
        it.each(sources)(`delivers the stable complete rules only as additionalContext for ${tool} %s`, async (source) => {
            const f = fixture();
            const result = channels(await runSessionStart(payload(f.cwd, source), tool, { ...QUIET, dbPath: f.dbPath }));
            expect(result.notice).toBeUndefined();
            expect(unwrapped(result.rules ?? '', 'rules')).toBe(
                [STANDING_RULES_AUTHORITY, ...f.rules.map((rule) => `- ${rule.text}`)].join('\n'),
            );
            for (const rule of f.rules) expect(result.rules).not.toContain(rule.ulid);
        });

        it(`delivers ${tool} chat rules for the same native chat across startup, compact and resume only`, async () => {
            const f = fixture(['Project rule.']);
            addChatRule(f.dbPath, f.project.id, f.cwd, tool, 'This chat only.');
            const combined = `${STANDING_RULES_AUTHORITY}\n- Project rule.\n\n${SESSION_RULES_AUTHORITY}\n- This chat only.`;
            for (const source of ['startup', 'compact', 'resume'] as const) {
                const result = channels(await runSessionStart(payload(f.cwd, source), tool, { ...QUIET, dbPath: f.dbPath }));
                expect(unwrapped(result.rules ?? '', 'rules')).toBe(combined);
            }
            for (const source of ['startup', 'clear', ...(tool === 'claude-code' ? ['fork' as const] : [])] as HookSource[]) {
                const result = channels(await runSessionStart(payload(f.cwd, source, 'new-chat'), tool, { ...QUIET, dbPath: f.dbPath }));
                expect(unwrapped(result.rules ?? '', 'rules')).toBe(`${STANDING_RULES_AUTHORITY}\n- Project rule.`);
            }
            const db = openUnmanagedDb(f.dbPath);
            try {
                const recorded = new MemoryStore(db).injectionsForSession(tool, 'rules-chat', ISO);
                expect(recorded.map(({ body }) => body)).toEqual([combined]);
                expect(
                    new MemoryStore(db).injectionsForSession(tool, 'new-chat', ISO).every(({ body }) => !body.includes('This chat only.')),
                ).toBe(true);
            } finally {
                db.close();
            }
        });

        it(`delivers ${tool} chat rules without project rules or notices`, async () => {
            const f = fixture([]);
            addChatRule(f.dbPath, f.project.id, f.cwd, tool, 'Only an explicit chat rule.');
            const result = channels(await runSessionStart(payload(f.cwd), tool, { ...QUIET, dbPath: f.dbPath }));
            expect(unwrapped(result.rules ?? '', 'rules')).toBe(`${SESSION_RULES_AUTHORITY}\n- Only an explicit chat rule.`);
            expect(result.notice).toBeUndefined();
        });

        it(`records both ${tool} channels independently without mixing their bodies`, async () => {
            const f = fixture();
            const result = channels(
                await runSessionStart(payload(f.cwd), tool, {
                    ...QUIET,
                    dbPath: f.dbPath,
                    daemonHealth: () => ({ state: 'STUCK', healthy: false }),
                }),
            );
            const ruleBody = unwrapped(result.rules ?? '', 'rules');
            const noticeBody = unwrapped(String(result.notice), 'notify');
            const db = openUnmanagedDb(f.dbPath);
            const store = new MemoryStore(db);
            try {
                expect(store.injectionsForSession(tool, 'rules-chat', ISO).map(({ body }) => body)).toEqual([ruleBody, noticeBody]);
                expect(ruleBody).not.toContain('daemon');
                expect(noticeBody).not.toContain(f.rules[0].text);
                expect(
                    store.isInjectionQuoteBack({
                        tool,
                        sessionId: 'rules-chat',
                        sourcePath: '',
                        projectPath: f.cwd,
                        turnIndex: 1,
                        startedAt: ISO,
                        endedAt: ISO,
                        userMessage: 'quote',
                        assistantText: ruleBody,
                        toolCalls: [],
                        cursor: '1',
                        hasExternalContent: false,
                        resumeMarkerBefore: false,
                    }),
                ).toBe(true);
            } finally {
                db.close();
            }
        });
    }

    it('delivers the maximum complete set without recall, rollup, truncation or management metadata', async () => {
        const texts = Array.from(
            { length: STANDING_RULES_MAX_ACTIVE },
            (_, index) => `${index}${'x'.repeat(STANDING_RULES_MAX_TOTAL_CHARS / STANDING_RULES_MAX_ACTIVE - 1)}`,
        );
        const f = fixture(texts);
        const result = channels(await runSessionStart(payload(f.cwd), 'codex', { ...QUIET, dbPath: f.dbPath }));
        expect(unwrapped(result.rules ?? '', 'rules')).toBe([STANDING_RULES_AUTHORITY, ...texts.map((text) => `- ${text}`)].join('\n'));
        expect(result.rules).not.toContain('[[elepha:brief:');
        expect(result.rules).not.toContain('rollup');
        expect(records(f.dbPath)[0].body.length).toBe(
            STANDING_RULES_AUTHORITY.length + STANDING_RULES_MAX_TOTAL_CHARS + 3 * STANDING_RULES_MAX_ACTIVE,
        );
    });

    it('keeps valid project rules when the chat-rule aggregate is invalid', async () => {
        const f = fixture(['Project rule.']);
        addChatRule(f.dbPath, f.project.id, f.cwd, 'codex', 'Chat rule.');
        const db = openUnmanagedDb(f.dbPath);
        db.prepare("UPDATE session_rules SET text = ''").run();
        db.close();
        const logs: string[] = [];
        const result = channels(
            await runSessionStart(payload(f.cwd), 'codex', { ...QUIET, dbPath: f.dbPath, log: (line) => logs.push(line) }),
        );
        expect(result.rules).toContain('Project rule.');
        expect(result.rules).not.toContain('Chat rule.');
        expect(records(f.dbPath).map((row) => row.body)).toEqual([`${STANDING_RULES_AUTHORITY}\n- Project rule.`]);
        expect(logs).toContain(`session-start codex source=startup session_id=rules-chat: skipped reason=${SESSION_RULES_INVALID}`);
    });

    it('reports an invalid chat-only aggregate without emitting rules', async () => {
        const f = fixture([]);
        addChatRule(f.dbPath, f.project.id, f.cwd, 'codex', 'Chat rule.');
        const db = openUnmanagedDb(f.dbPath);
        db.prepare("UPDATE session_rules SET text = ''").run();
        db.close();
        const logs: string[] = [];
        expect(await runSessionStart(payload(f.cwd), 'codex', { ...QUIET, dbPath: f.dbPath, log: (line) => logs.push(line) })).toEqual({
            reason: SESSION_RULES_INVALID,
        });
        expect(records(f.dbPath)).toEqual([]);
        expect(logs).toContain(`session-start codex source=startup session_id=rules-chat: skipped reason=${SESSION_RULES_INVALID}`);
    });

    it('records the complete chat-rule delivery atomically or emits nothing', async () => {
        const f = fixture([]);
        addChatRule(f.dbPath, f.project.id, f.cwd, 'codex', 'Private chat rule.');
        const result = await runSessionStart(payload(f.cwd), 'codex', {
            ...QUIET,
            dbPath: f.dbPath,
            writeInjection: (store, input) => {
                expect(store.database.inTransaction).toBe(true);
                store.recordInjection(input);
                return false;
            },
        });
        expect(result).toEqual({ reason: 'injection_record_failed' });
        expect(records(f.dbPath)).toEqual([]);
    });

    it.each(['count', 'total', 'single', 'empty', 'malformed'])(
        'diagnoses invalid %s rules without context, text or counts',
        async (kind) => {
            const f = fixture(kind === 'total' ? Array.from({ length: 4 }, (_, i) => `${i}${'x'.repeat(299)}`) : ['Original rule.']);
            const db = openUnmanagedDb(f.dbPath);
            if (kind === 'single' || kind === 'empty' || kind === 'malformed')
                db.prepare('UPDATE standing_rules SET text = ?').run(
                    kind === 'empty' ? '' : kind === 'malformed' ? Buffer.from('Private malformed rule.') : 'x'.repeat(301),
                );
            else {
                const peer = path.join(f.cwd, 'previously-separate');
                fs.mkdirSync(peer);
                const store = new MemoryStore(db, { resolveGitRoot: () => null, resolveGitRemote: () => null });
                const member = store.upsertProject(peer);
                // Each owner can hold a valid set before logical grouping joins them.
                for (let i = 0; i < (kind === 'count' ? STANDING_RULES_MAX_ACTIVE : 1); i++) {
                    expect(
                        store.standingRules.add(
                            { projectIds: [member.id], ownerProjectId: member.id, stillConsented: () => true },
                            `Peer rule ${i}.`,
                            ISO,
                        ).status,
                    ).toBe('added');
                }
            }
            db.close();
            const logs: string[] = [];
            expect(await runSessionStart(payload(f.cwd), 'codex', { ...QUIET, dbPath: f.dbPath, log: (line) => logs.push(line) })).toEqual({
                reason: STANDING_RULES_INVALID,
            });
            expect(logs).toEqual([`session-start codex source=startup session_id=rules-chat: skipped reason=${STANDING_RULES_INVALID}`]);
            expect(records(f.dbPath)).toEqual([]);
        },
    );

    it('keeps the invalid-rules diagnostic internal while delivering an independent operational notice', async () => {
        const f = fixture();
        const db = openUnmanagedDb(f.dbPath);
        db.prepare('UPDATE standing_rules SET text = ?').run(Buffer.from('Private malformed rule.'));
        db.close();
        const logs: string[] = [];
        const result = channels(
            await runSessionStart(payload(f.cwd), 'codex', {
                ...QUIET,
                dbPath: f.dbPath,
                daemonHealth: () => ({ state: 'STUCK', healthy: false }),
                log: (line) => logs.push(line),
            }),
        );
        expect(result.rules).toBeUndefined();
        const body = unwrapped(String(result.notice), 'notify');
        expect(body).not.toContain(STANDING_RULES_INVALID);
        expect(body).not.toContain('Private');
        expect(records(f.dbPath).map((row) => row.body)).toEqual([body]);
        expect(logs).toEqual([
            `session-start codex source=startup session_id=rules-chat: skipped reason=${STANDING_RULES_INVALID}`,
            'session-start codex source=startup session_id=rules-chat: emitted output',
        ]);
    });

    it('keeps a legitimate empty rule set distinct from invalid stored rules', async () => {
        const f = fixture([]);
        const logs: string[] = [];
        expect(await runSessionStart(payload(f.cwd), 'codex', { ...QUIET, dbPath: f.dbPath, log: (line) => logs.push(line) })).toEqual({
            reason: 'no_notice',
        });
        expect(logs).toEqual([]);
        expect(records(f.dbPath)).toEqual([]);
    });

    it.each(['Use foo.', 'Use foo!'])('preserves exact same-chat rule replacements: %s', async (text) => {
        const f = fixture(['Use Foo.']);
        await runSessionStart(payload(f.cwd), 'codex', { ...QUIET, dbPath: f.dbPath });
        const db = openUnmanagedDb(f.dbPath);
        const store = new MemoryStore(db);
        expect(
            store.standingRules.replace(
                { projectIds: [f.project.id], ownerProjectId: f.project.id, stillConsented: () => true },
                f.rules[0].ulid,
                text,
            ).status,
        ).toBe('replaced');
        db.close();
        const result = channels(await runSessionStart(payload(f.cwd, 'resume'), 'codex', { ...QUIET, dbPath: f.dbPath }));
        expect(unwrapped(result.rules ?? '', 'rules')).toBe(`${STANDING_RULES_AUTHORITY}\n- ${text}`);
        expect(records(f.dbPath).map(({ body }) => body)).toEqual([
            `${STANDING_RULES_AUTHORITY}\n- Use Foo.`,
            `${STANDING_RULES_AUTHORITY}\n- ${text}`,
        ]);
    });

    it.each(['first false', 'second false', 'first throw', 'second throw'])('rolls back both attribution writes on %s', async (failure) => {
        const f = fixture();
        let writes = 0;
        const result = await runSessionStart(payload(f.cwd), 'codex', {
            ...QUIET,
            dbPath: f.dbPath,
            daemonHealth: () => ({ state: 'STUCK', healthy: false }),
            writeInjection: (store, input) => {
                writes++;
                const recorded = store.recordInjection(input);
                if (writes === (failure.startsWith('first') ? 1 : 2)) {
                    if (failure.endsWith('throw')) throw new Error('write failed');
                    return false;
                }
                return recorded;
            },
        });
        expect(result).toEqual({ reason: 'injection_record_failed' });
        expect(records(f.dbPath)).toEqual([]);
    });

    it.each(['revoke', 'add-member', 'change-identity', 'remove-member', 'generation', 'lock'])(
        'emits no rule after %s at the delivery checkpoint',
        async (change) => {
            const f = fixture();
            const result = await runSessionStart(payload(f.cwd), 'codex', {
                ...QUIET,
                dbPath: f.dbPath,
                beforeDelivery: (db) => {
                    expect(db.inTransaction).toBe(false);
                    if (change === 'revoke') db.exec("UPDATE consent_roots SET state = 'denied'");
                    else if (change === 'add-member')
                        new MemoryStore(db, { resolveGitRoot: () => null, resolveGitRemote: () => null }).upsertProject(
                            path.join(f.cwd, 'new-member'),
                        );
                    else if (change === 'change-identity') db.exec("UPDATE projects SET git_remote = 'https://changed.test/repo'");
                    else if (change === 'remove-member') db.exec('DELETE FROM standing_rules; DELETE FROM projects');
                    else if (change === 'generation') db.exec('UPDATE paranoid_authority SET generation = generation + 1');
                    else db.exec("UPDATE paranoid_authority SET enrolled = 1, state = 'locked'");
                },
            });
            expect(result).toEqual({ reason: 'no_notice' });
            expect(records(f.dbPath)).toEqual([]);
        },
    );

    it('checks the canonical caller even when other logical members remain approved', async () => {
        const f = fixture();
        const db = openUnmanagedDb(f.dbPath);
        db.prepare(
            "INSERT INTO consent_roots (ulid, path, state, decided_at, source) VALUES ('01J00000000000000000000001', ?, 'approved', ?, 'cli')",
        ).run(f.directory, ISO);
        db.close();
        const baseline = await runSessionStart(payload(f.directory), 'codex', { ...QUIET, dbPath: f.dbPath });
        expect(channels(baseline).rules).toBeDefined();
        const priorRecords = records(f.dbPath);
        const result = await runSessionStart(payload(f.directory), 'codex', {
            ...QUIET,
            dbPath: f.dbPath,
            beforeDelivery: (db) => {
                db.prepare("UPDATE consent_roots SET state = 'denied' WHERE path = ?").run(f.directory);
                expect(db.prepare('SELECT state FROM consent_roots WHERE path = ?').get(f.cwd)).toEqual({ state: 'approved' });
            },
        });
        expect(result).toEqual({ reason: 'no_notice' });
        expect(records(f.dbPath)).toEqual(priorRecords);
    });

    it('uses no filesystem or Git while authorizing and recording in the writer transaction', async () => {
        const f = fixture();
        const realpath = fs.realpathSync;
        const git = subprocess.gitRevParseShowToplevel;
        const spies: Array<{ mockRestore(): void }> = [];
        const logs: string[] = [];
        try {
            const result = await runSessionStart(payload(f.cwd), 'codex', {
                ...QUIET,
                dbPath: f.dbPath,
                log: (line) => logs.push(line),
                beforeDelivery: (db) => {
                    spies.push(
                        vi.spyOn(fs, 'realpathSync').mockImplementation((p, options) => {
                            expect(db.inTransaction).toBe(false);
                            return realpath(p, options);
                        }),
                    );
                    syncBuiltinESMExports();
                    spies.push(
                        vi.spyOn(subprocess, 'gitRevParseShowToplevel').mockImplementation((cwd) => {
                            expect(db.inTransaction).toBe(false);
                            return git(cwd);
                        }),
                    );
                },
                writeInjection: (store, input) => {
                    expect(store.database.inTransaction).toBe(true);
                    return store.recordInjection(input);
                },
            });
            expect('output' in result, logs.join('\n')).toBe(true);
            expect(channels(result).rules).toBeDefined();
        } finally {
            for (const spy of spies) spy.mockRestore();
            syncBuiltinESMExports();
        }
    });

    it.each(['unconsented', 'denied', 'no-rules', 'missing', 'unreadable'])('fails open without rule leakage for %s', async (state) => {
        const f = fixture();
        const db = openUnmanagedDb(f.dbPath);
        if (state === 'unconsented') db.exec('DELETE FROM consent_roots');
        if (state === 'denied') db.exec("UPDATE consent_roots SET state = 'denied'");
        if (state === 'no-rules') db.exec('DELETE FROM standing_rules');
        db.close();
        const result = await runSessionStart(payload(f.cwd), 'codex', {
            ...QUIET,
            dbPath: state === 'missing' ? path.join(f.directory, 'missing.db') : f.dbPath,
            ...(state === 'unreadable'
                ? {
                      openDatabase: () => {
                          throw new Error('unreadable');
                      },
                  }
                : {}),
        });
        expect(result).toEqual({ reason: state === 'missing' || state === 'unreadable' ? 'database_unavailable' : 'no_notice' });
        expect(records(f.dbPath)).toEqual([]);
    });
});
