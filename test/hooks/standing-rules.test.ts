import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
    PROJECT_AUTHORIZATION_ROW_MAX_BYTES,
    STANDING_RULE_MAX_CHARS,
    STANDING_RULES_MAX_ACTIVE,
    STANDING_RULES_MAX_TOTAL_CHARS,
} from '../../src/config/constants.js';
import { getSetting } from '../../src/config/settings.js';
import { runSessionStart } from '../../src/hooks/session-start.js';
import { parseStandingRulesPayload, runStandingRulesHook } from '../../src/hooks/standing-rules.js';
import { parseUserPromptCommand, runUserPromptSubmit } from '../../src/hooks/user-prompt-submit.js';
import { detectShellSyntax } from '../../src/security/sanitize.js';
import * as subprocess from '../../src/security/subprocess-allowlist.js';
import { DISPLAY_VERBATIM_INSTRUCTIONS, HELP } from '../../src/serving/instructions.js';
import {
    parseScopedStandingRulesCommand,
    SESSION_RULES_AMBIGUOUS,
    SESSION_RULES_ANCHOR_AMBIGUOUS,
    SESSION_RULES_CONTEXT_UNVERIFIED,
    STANDING_RULE_REJECTIONS,
    STANDING_RULES_EMPTY,
    STANDING_RULES_HINT,
    STANDING_RULES_UNCONSENTED,
    type StandingRulesCommand,
    standingRulesCommandBody,
} from '../../src/serving/standing-rules.js';
import { ConsentStore } from '../../src/storage/consent-store.js';
import { openDb, openUnmanagedDb } from '../../src/storage/db.js';
import { MemoryStore } from '../../src/storage/memory-store.js';
import {
    enableParanoidMode,
    isMemoryLocked,
    LOCKED_MEMORY_MESSAGE,
    lockMemory,
    registerParanoidDatabase,
    unlockMemory,
} from '../../src/storage/paranoid-gate.js';
import { type SessionRuleRow, SessionRulesStore } from '../../src/storage/session-rules-store.js';
import type { StandingRuleRow } from '../../src/storage/standing-rules-store.js';
import { createTestDb, seedConsentRoot, seedProject } from '../helpers/db.js';
import { fixtureGitEnv } from '../helpers/git.js';
import { withGrantableTestDir } from '../helpers/tmp.js';

const NOW = Date.parse('2026-09-20T00:00:00.000Z');
const ISO = new Date(NOW).toISOString();
// Well-formed but absent: 26 characters from the Crockford alphabet the shared
// ULID helper emits.
const ABSENT_RULE_ID = `01K5${'Z'.repeat(22)}`;
// Same length, but I is outside that alphabet, so it is not a command at all.
const MALFORMED_RULE_ID = `01K5${'Z'.repeat(21)}I`;

interface RulesFixture {
    dbPath: string;
    projectPath: string;
}

// Each fixture directory carries its own Git boundary, so two fixture projects
// never collapse into one resolved ProjectSet.
function seededDb(prefix: string, seed: readonly string[] = []): RulesFixture {
    const fixture = createTestDb(prefix);
    const projectPath = path.join(fixture.directory, 'project');
    mkdirSync(projectPath, { recursive: true });
    const project = seedProject(fixture, { path: projectPath });
    seedConsentRoot(fixture, { path: projectPath, state: 'approved' });
    for (const text of seed) {
        const outcome = fixture.store.standingRules.add(
            { projectIds: [project.id], ownerProjectId: project.id, stillConsented: () => true },
            text,
            ISO,
        );
        expect(outcome.status).toBe('added');
    }
    fixture.close();
    return { dbPath: fixture.dbPath, projectPath };
}

function payload(cwd: string, prompt: string, sessionId = 'rules-chat'): string {
    return JSON.stringify({
        session_id: sessionId,
        cwd,
        hook_event_name: 'UserPromptSubmit',
        prompt,
        model: 'gpt-5.6',
        permission_mode: 'default',
        transcript_path: null,
    });
}

function injectedBody(result: Awaited<ReturnType<typeof runUserPromptSubmit>>): string {
    if (!('output' in result)) {
        throw new Error(`command did not emit: ${result.reason}`);
    }
    const context = (result.output.hookSpecificOutput as Record<string, string>).additionalContext;
    expect(context).toMatch(/^\[\[elepha:brief:[0-9A-Z]{26}]]\n/);
    return context.split('\n').slice(1, -1).join('\n');
}

async function submit(fixture: RulesFixture, prompt: string, cwd = fixture.projectPath): Promise<string> {
    return injectedBody(await runUserPromptSubmit(payload(cwd, prompt), 'codex', { dbPath: fixture.dbPath, now: () => NOW }));
}

function storedRules(fixture: RulesFixture): StandingRuleRow[] {
    const db = openUnmanagedDb(fixture.dbPath);
    try {
        return db.prepare('SELECT id, ulid, project_id, text, created_at FROM standing_rules ORDER BY id').all() as StandingRuleRow[];
    } finally {
        db.close();
    }
}

function storedSessionRules(fixture: RulesFixture): SessionRuleRow[] {
    const db = openUnmanagedDb(fixture.dbPath);
    try {
        return db.prepare('SELECT * FROM session_rules ORDER BY id').all() as SessionRuleRow[];
    } finally {
        db.close();
    }
}

describe('elepha:rules in-chat grammar', () => {
    it('parses only the exact anchored forms', () => {
        expect(parseUserPromptCommand('  elepha:rules  ')).toEqual({ kind: 'rules' });
        expect(parseUserPromptCommand('elepha:rules:add Always run the focused test.')).toEqual({
            kind: 'rules-add',
            text: 'Always run the focused test.',
        });
        expect(parseUserPromptCommand('elepha:rules:add')).toEqual({ kind: 'rules-add', text: '' });
        expect(parseUserPromptCommand(`elepha:rules:remove ${ABSENT_RULE_ID}`)).toEqual({
            kind: 'rules-remove',
            ruleId: ABSENT_RULE_ID,
        });
        expect(parseUserPromptCommand(`elepha:rules:replace ${ABSENT_RULE_ID} Never edit dist.`)).toEqual({
            kind: 'rules-replace',
            ruleId: ABSENT_RULE_ID,
            text: 'Never edit dist.',
        });
        expect(parseUserPromptCommand(`elepha:rules:replace ${ABSENT_RULE_ID}`)).toEqual({
            kind: 'rules-replace',
            ruleId: ABSENT_RULE_ID,
            text: '',
        });

        for (const input of [
            'elepha:rules:list',
            'elepha:rules:',
            'elepha:rule',
            'elepha:rules extra',
            'Elepha:rules',
            `elepha:rules:remove ${MALFORMED_RULE_ID}`,
            'elepha:rules:remove 01K5ZZZ',
            'elepha:rules:remove',
            'elepha:rules:replace 01K5ZZZ some text',
        ]) {
            expect(parseUserPromptCommand(input), input).toBeUndefined();
        }
    });

    it('names every rule command in the in-chat help', () => {
        for (const command of ['elepha:rules', 'elepha:rules:add', 'elepha:rules:remove', 'elepha:rules:replace']) {
            expect(HELP.split('\n').some((line) => line.startsWith(`${command} `))).toBe(true);
        }
        expect(HELP).toContain('elepha:rules — List project standing rules and rules for this chat in this checkout.');
        expect(HELP).toContain(
            'Chat standing-rule commands are available in Claude Code, Codex and top-level OpenCode chats; OpenCode subagent sessions cannot use them.',
        );
    });

    it('parses explicit project and chat scope forms without changing legacy commands', () => {
        for (const scope of ['project', 'session'] as const) {
            expect(parseScopedStandingRulesCommand(`elepha:rules:${scope}`)).toEqual({ kind: 'rules-scoped', scope, action: 'list' });
            expect(parseScopedStandingRulesCommand(`elepha:rules:${scope}:add Text.`)).toEqual({
                kind: 'rules-scoped',
                scope,
                action: 'add',
                text: 'Text.',
            });
            expect(parseScopedStandingRulesCommand(`elepha:rules:${scope}:add`)).toEqual({
                kind: 'rules-scoped',
                scope,
                action: 'add',
                text: '',
            });
            expect(parseScopedStandingRulesCommand(`elepha:rules:${scope}:remove ${ABSENT_RULE_ID}`)).toEqual({
                kind: 'rules-scoped',
                scope,
                action: 'remove',
                ruleId: ABSENT_RULE_ID,
            });
            expect(parseScopedStandingRulesCommand(`elepha:rules:${scope}:replace ${ABSENT_RULE_ID} Changed.`)).toEqual({
                kind: 'rules-scoped',
                scope,
                action: 'replace',
                ruleId: ABSENT_RULE_ID,
                text: 'Changed.',
            });
            expect(parseScopedStandingRulesCommand(`elepha:rules:${scope}:replace ${ABSENT_RULE_ID}`)).toEqual({
                kind: 'rules-scoped',
                scope,
                action: 'replace',
                ruleId: ABSENT_RULE_ID,
                text: '',
            });
            for (const action of ['', ':add', ':remove', ':replace']) {
                const command = `elepha:rules:${scope}${action}`;
                expect(HELP.split('\n').some((line) => line.startsWith(`${command} `))).toBe(true);
            }
        }
        expect(parseScopedStandingRulesCommand('elepha:rules:add Legacy project rule.')).toBeUndefined();
        expect(parseUserPromptCommand('elepha:rules:add Legacy project rule.')).toEqual({
            kind: 'rules-add',
            text: 'Legacy project rule.',
        });
        expect(parseUserPromptCommand('elepha:rules:session:add Chat rule.')).toEqual({
            kind: 'rules-scoped',
            scope: 'session',
            action: 'add',
            text: 'Chat rule.',
        });
    });

    it('rejects malformed or ambiguous explicit scope forms', () => {
        for (const input of [
            'elepha:rules:project:list',
            'elepha:rules:session:list',
            'elepha:rules:project extra',
            'elepha:rules:session:',
            'elepha:rules:project:remove',
            'elepha:rules:session:remove 01K5ZZZ',
            `elepha:rules:session:remove ${MALFORMED_RULE_ID}`,
            `elepha:rules:project:replace ${MALFORMED_RULE_ID} Text.`,
            'elepha:rules:session:replace 01K5ZZZ Text.',
            'elepha:rules:personal:add Text.',
            'Elepha:rules:session:add Text.',
            'elepha:rules:session:addition Text.',
        ]) {
            expect(parseScopedStandingRulesCommand(input), input).toBeUndefined();
        }
    });
});

describe('elepha:rules management', () => {
    it.each(['claude-code', 'codex'] as const)(
        'does not let a %s subagent sharing its parent session id mutate rules or hook state',
        async (tool) => {
            const f = seededDb('elepha-rules-subagent-', ['Keep this rule.']);
            const original = storedRules(f);
            const childPayload = (prompt: string) =>
                JSON.stringify({
                    ...JSON.parse(payload(f.projectPath, prompt)),
                    agent_id: 'agent-child',
                    agent_type: 'Explore',
                });
            const openDatabase = vi.fn(openDb);
            const childDependencies = { dbPath: f.dbPath, now: () => NOW, openDatabase: openDatabase as unknown as typeof openDb };
            for (const prompt of [
                'elepha:rules:add Do not save this.',
                `elepha:rules:remove ${original[0]!.ulid}`,
                `elepha:rules:replace ${original[0]!.ulid} Do not replace this.`,
                'elepha:list',
            ]) {
                expect(await runUserPromptSubmit(childPayload(prompt), tool, childDependencies)).toEqual({
                    reason: 'subagent_context',
                });
            }
            for (const agentId of [null, 7, '', ' ']) {
                const malformed = JSON.stringify({
                    ...JSON.parse(payload(f.projectPath, 'elepha:rules:add Do not save this.')),
                    agent_id: agentId,
                    agent_type: 'Explore',
                });
                expect(await runUserPromptSubmit(malformed, tool, childDependencies)).toEqual({
                    reason: 'invalid_payload',
                });
            }
            expect(openDatabase).not.toHaveBeenCalled();
            expect(storedRules(f)).toEqual(original);
            const db = openUnmanagedDb(f.dbPath);
            try {
                expect(db.prepare('SELECT COUNT(*) AS count FROM injections').get()).toEqual({ count: 0 });
                expect(db.prepare('SELECT COUNT(*) AS count FROM shown_session_lists').get()).toEqual({ count: 0 });
            } finally {
                db.close();
            }

            const mainPayload = JSON.stringify({
                ...JSON.parse(payload(f.projectPath, 'elepha:rules:add Main chat only.')),
                ...(tool === 'claude-code' ? { agent_type: 'custom-main-agent' } : {}),
            });
            const main = await runUserPromptSubmit(mainPayload, tool, { dbPath: f.dbPath, now: () => NOW });
            expect(injectedBody(main)).toContain('Main chat only.');
            expect(storedRules(f).map((rule) => rule.text)).toEqual(['Keep this rule.', 'Main chat only.']);
        },
    );

    it('lists and adds rules when an approved same-identity worktree no longer exists', async () => {
        const f = createTestDb('elepha-rules-retired-worktree-');
        const projectPath = path.join(f.directory, 'live-worktree');
        const retiredPath = path.join(f.directory, 'retired-worktree');
        mkdirSync(projectPath);
        const live = seedProject(f, { path: projectPath });
        const retired = seedProject(f, { path: retiredPath });
        f.db.prepare('UPDATE projects SET git_remote = ? WHERE id IN (?, ?)').run('https://example.test/shared', live.id, retired.id);
        seedConsentRoot(f, { path: f.directory });
        expect(existsSync(retiredPath)).toBe(false);
        f.close();

        const scope = { dbPath: f.dbPath, projectPath };
        expect(await submit(scope, 'elepha:rules')).toContain(STANDING_RULES_EMPTY);
        expect(await submit(scope, 'elepha:rules:add Preserve the live checkout rule.')).toContain('Preserve the live checkout rule.');
        expect(await submit(scope, 'elepha:rules')).toContain('Preserve the live checkout rule.');
        expect(storedRules(scope).map((rule) => rule.text)).toEqual(['Preserve the live checkout rule.']);

        const db = openUnmanagedDb(f.dbPath);
        new ConsentStore(db).revoke(retiredPath);
        db.close();
        expect(await submit(scope, 'elepha:rules')).toContain(STANDING_RULES_UNCONSENTED);
        expect(await submit(scope, 'elepha:rules:add Must not cross denial.')).toContain(STANDING_RULES_UNCONSENTED);
        expect(storedRules(scope).map((rule) => rule.text)).toEqual(['Preserve the live checkout rule.']);
    });

    it.each(['retired-worktree', '../retired-worktree'])(
        'refuses a missing same-identity member beneath a symlink into a denied root: %s',
        async (suffix) => {
            const f = createTestDb('elepha-rules-denied-symlink-parent-');
            const projectPath = path.join(f.directory, 'live-worktree');
            const deniedRoot = path.join(f.directory, 'denied-root');
            const alias = path.join(f.directory, 'alias');
            const retiredPath = `${alias}/${suffix}`;
            mkdirSync(projectPath);
            const symlinkTarget = path.join(deniedRoot, 'subdir');
            mkdirSync(symlinkTarget, { recursive: true });
            symlinkSync(symlinkTarget, alias);
            const live = seedProject(f, { path: projectPath });
            const retired = seedProject(f, { path: retiredPath });
            f.db.prepare('UPDATE projects SET git_remote = ? WHERE id IN (?, ?)').run('https://example.test/shared', live.id, retired.id);
            seedConsentRoot(f, { path: f.directory });
            seedConsentRoot(f, { path: deniedRoot, state: 'denied' });
            expect(
                f.store.standingRules.add(
                    { projectIds: [live.id, retired.id], ownerProjectId: live.id, stillConsented: () => true },
                    'Private live rule.',
                    ISO,
                ).status,
            ).toBe('added');
            expect(existsSync(retiredPath)).toBe(false);
            f.close();

            const scope = { dbPath: f.dbPath, projectPath };
            const listed = await submit(scope, 'elepha:rules');
            expect(listed).toContain(STANDING_RULES_UNCONSENTED);
            expect(listed).not.toContain('Private live rule.');
            expect(await submit(scope, 'elepha:rules:add Must not cross denial.')).toContain(STANDING_RULES_UNCONSENTED);
            expect(storedRules(scope).map((rule) => rule.text)).toEqual(['Private live rule.']);

            const delivery = await runSessionStart(
                JSON.stringify({
                    session_id: 'rules-chat',
                    cwd: projectPath,
                    hook_event_name: 'SessionStart',
                    source: 'startup',
                    model: 'test',
                    permission_mode: 'default',
                }),
                'codex',
                {
                    dbPath: f.dbPath,
                    now: () => NOW,
                    daemonHealth: () => ({ state: 'RUNNING', healthy: true }),
                    readUpdateAvailable: () => undefined,
                },
            );
            expect(delivery).toEqual({ reason: 'no_notice' });
        },
    );

    it('adds the first rule in a granted directory before any session creates a project row', async () => {
        const fixture = createTestDb('elepha-rules-first-use-db-');
        const projectPath = withGrantableTestDir('elepha-rules-first-use-project-');
        seedConsentRoot(fixture, { path: projectPath, state: 'approved' });
        fixture.close();

        const result = await runUserPromptSubmit(payload(projectPath, 'elepha:rules:add Remember this project.'), 'codex', {
            dbPath: fixture.dbPath,
            now: () => NOW,
        });
        const body = injectedBody(result);
        expect(body).toContain('Remember this project.');
        expect(body).not.toContain(STANDING_RULES_UNCONSENTED);
        const rules = storedRules({ dbPath: fixture.dbPath, projectPath });
        expect(rules).toHaveLength(1);
        const db = openUnmanagedDb(fixture.dbPath);
        try {
            expect(db.prepare('SELECT id, path FROM projects').all()).toEqual([{ id: rules[0]?.project_id, path: projectPath }]);
        } finally {
            db.close();
        }
    });

    it('keeps a first rule inside the granted part of a Git checkout', async () => {
        const root = withGrantableTestDir('elepha-rules-first-use-git-');
        const repo = path.join(root, 'repo');
        const subdirectory = path.join(repo, 'allowed');
        mkdirSync(subdirectory, { recursive: true });
        execFileSync('git', ['-c', 'init.templateDir=/dev/null', 'init', '-q', repo], { env: fixtureGitEnv() });

        const limited = createTestDb('elepha-rules-first-use-subdir-db-');
        seedConsentRoot(limited, { path: subdirectory, state: 'approved' });
        limited.close();
        const remoteProbe = vi.spyOn(subprocess, 'gitRemoteGetUrlOrigin');
        const commitProbe = vi.spyOn(subprocess, 'gitRootCommit');
        try {
            expect(
                injectedBody(
                    await runUserPromptSubmit(payload(subdirectory, 'elepha:rules:add Inside grant.'), 'codex', {
                        dbPath: limited.dbPath,
                        now: () => NOW,
                    }),
                ),
            ).toContain('Inside grant.');
            expect(remoteProbe).not.toHaveBeenCalled();
            expect(commitProbe).not.toHaveBeenCalled();
        } finally {
            remoteProbe.mockRestore();
            commitProbe.mockRestore();
        }
        const limitedDb = openUnmanagedDb(limited.dbPath);
        try {
            expect(limitedDb.prepare('SELECT path, git_root FROM projects').all()).toEqual([{ path: subdirectory, git_root: null }]);
        } finally {
            limitedDb.close();
        }
        expect(await submit({ dbPath: limited.dbPath, projectPath: subdirectory }, 'elepha:rules')).toContain('Inside grant.');
        expect(await submit({ dbPath: limited.dbPath, projectPath: subdirectory }, 'elepha:rules', repo)).toContain(
            STANDING_RULES_UNCONSENTED,
        );

        const whole = createTestDb('elepha-rules-first-use-repo-db-');
        seedConsentRoot(whole, { path: repo, state: 'approved' });
        whole.close();
        const approvedRemoteProbe = vi.spyOn(subprocess, 'gitRemoteGetUrlOrigin');
        const approvedCommitProbe = vi.spyOn(subprocess, 'gitRootCommit');
        try {
            expect(
                injectedBody(
                    await runUserPromptSubmit(payload(subdirectory, 'elepha:rules:add Whole checkout.'), 'codex', {
                        dbPath: whole.dbPath,
                        now: () => NOW,
                    }),
                ),
            ).toContain('Whole checkout.');
            expect(approvedRemoteProbe).toHaveBeenCalledWith(repo);
            expect(approvedCommitProbe).toHaveBeenCalledWith(repo);
        } finally {
            approvedRemoteProbe.mockRestore();
            approvedCommitProbe.mockRestore();
        }
        const wholeDb = openUnmanagedDb(whole.dbPath);
        try {
            expect(wholeDb.prepare('SELECT path, git_root FROM projects').all()).toEqual([{ path: repo, git_root: repo }]);
        } finally {
            wholeDb.close();
        }
    });

    it('does not reveal or mutate a pending root rule from an approved child in a legacy multi-row project', async () => {
        const directory = withGrantableTestDir('elepha-rules-legacy-peer-');
        const repo = path.join(directory, 'repo');
        const child = path.join(repo, 'allowed');
        mkdirSync(child, { recursive: true });
        execFileSync('git', ['-c', 'init.templateDir=/dev/null', 'init', '-q', repo], { env: fixtureGitEnv() });
        const f = createTestDb('elepha-rules-legacy-peer-db-');
        const root = f.store.upsertProject(repo);
        const member = f.store.upsertProject(child);
        expect(member.id).not.toBe(root.id);
        f.db.prepare('UPDATE projects SET git_remote = ? WHERE id IN (?, ?)').run('https://example.test/shared-repo', root.id, member.id);
        const rootGrant = seedConsentRoot(f, { path: repo });
        expect(
            f.store.standingRules.add(
                { projectIds: [root.id, member.id], ownerProjectId: root.id, stillConsented: () => true },
                'Private root rule.',
                ISO,
            ).status,
        ).toBe('added');
        const [saved] = f.store.standingRules.list([root.id]);
        f.store.consent.remove(rootGrant.ulid);
        seedConsentRoot(f, { path: child });
        f.close();

        const scope = { dbPath: f.dbPath, projectPath: child };
        for (const prompt of [
            'elepha:rules',
            `elepha:rules:remove ${saved?.ulid}`,
            `elepha:rules:replace ${saved?.ulid} Mutated root rule.`,
            'elepha:rules:add Child attempt.',
        ]) {
            const body = await submit(scope, prompt);
            expect(body).toBe(`${DISPLAY_VERBATIM_INSTRUCTIONS}\n${STANDING_RULES_UNCONSENTED}`);
        }
        expect(storedRules(scope).map((rule) => rule.text)).toEqual(['Private root rule.']);
    });

    it('keeps child-only rule management available after an earlier Git-root capture', async () => {
        const directory = withGrantableTestDir('elepha-rules-captured-root-');
        const repo = path.join(directory, 'repo');
        const child = path.join(repo, 'allowed');
        mkdirSync(child, { recursive: true });
        execFileSync('git', ['-c', 'init.templateDir=/dev/null', 'init', '-q', repo], { env: fixtureGitEnv() });
        const f = createTestDb('elepha-rules-captured-root-db-');
        seedConsentRoot(f, { path: child });
        const captured = new MemoryStore(f.db).upsertProject(child);
        expect(captured.path).toBe(repo);
        f.close();

        const scope = { dbPath: f.dbPath, projectPath: child };
        expect(await submit(scope, 'elepha:rules:add Child-only rule.')).toContain('Child-only rule.');
        const [rule] = storedRules(scope);
        expect(rule).toBeDefined();
        expect(await submit(scope, 'elepha:rules')).toContain('Child-only rule.');
        expect(await submit(scope, `elepha:rules:replace ${rule?.ulid} Updated child rule.`)).toContain('Updated child rule.');
        expect(await submit(scope, `elepha:rules:remove ${rule?.ulid}`)).toContain('Updated child rule.');
        expect(storedRules(scope)).toEqual([]);
        expect(await submit(scope, 'elepha:rules', repo)).toContain(STANDING_RULES_UNCONSENTED);
    });

    it('creates no project owner for a refused or unreceipted first rule', async () => {
        const fixture = createTestDb('elepha-rules-first-use-rollback-');
        const projectPath = withGrantableTestDir('elepha-rules-first-use-rollback-project-');
        seedConsentRoot(fixture, { path: projectPath, state: 'approved' });
        fixture.close();

        expect(await submit({ dbPath: fixture.dbPath, projectPath }, 'elepha:rules')).toContain(STANDING_RULES_EMPTY);
        const filePath = path.join(projectPath, 'not-a-directory.txt');
        writeFileSync(filePath, 'data');
        expect(await submit({ dbPath: fixture.dbPath, projectPath }, 'elepha:rules:add Not a project.', filePath)).toContain(
            STANDING_RULES_UNCONSENTED,
        );
        expect(await submit({ dbPath: fixture.dbPath, projectPath }, 'elepha:rules:add   ')).toContain(STANDING_RULE_REJECTIONS.empty);
        const failed = await runUserPromptSubmit(payload(projectPath, 'elepha:rules:add Unseen rule.'), 'codex', {
            dbPath: fixture.dbPath,
            now: () => NOW,
            writeInjection: (store, input) => {
                store.recordInjection(input);
                return false;
            },
        });
        expect(failed).toEqual({ reason: 'injection_record_failed' });
        const db = openUnmanagedDb(fixture.dbPath);
        try {
            expect(db.prepare('SELECT count(*) AS count FROM projects').get()).toEqual({ count: 0 });
            expect(db.prepare('SELECT count(*) AS count FROM standing_rules').get()).toEqual({ count: 0 });
            expect(db.prepare('SELECT count(*) AS count FROM injections').get()).toEqual({ count: 3 });
        } finally {
            db.close();
        }
    });

    it('adds, lists, replaces and removes rules with Memory-Plus off and no provider configured', async () => {
        const configPath = path.join(withGrantableTestDir('elepha-rules-config-'), 'config.json');
        expect(getSetting('memory-plus', {}, configPath).value).toBe(false);
        const fixture = seededDb('elepha-rules-roundtrip-');

        const empty = await submit(fixture, 'elepha:rules');
        expect(empty).toBe(
            [
                DISPLAY_VERBATIM_INSTRUCTIONS,
                'Project standing rules (none):',
                STANDING_RULES_EMPTY,
                '',
                STANDING_RULES_HINT,
                '',
                'Standing rules for this chat in this checkout (none):',
                'No standing rules for this chat in this checkout yet. Add one with elepha:rules:session:add <text>.',
            ].join('\n'),
        );

        const added = await submit(fixture, 'elepha:rules:add Always run the focused test before the suite.');
        const [first] = storedRules(fixture);
        expect(first?.text).toBe('Always run the focused test before the suite.');
        expect(added).toContain(`[${first?.ulid}] Always run the focused test before the suite.`);
        expect(added).toContain(`1 of ${STANDING_RULES_MAX_ACTIVE}`);

        await submit(fixture, 'elepha:rules:add Never edit dist by hand.');
        const listed = await submit(fixture, 'elepha:rules');
        const rules = storedRules(fixture);
        // Stable creation order, with the full copyable id for each rule.
        expect(rules.map((rule) => rule.text)).toEqual(['Always run the focused test before the suite.', 'Never edit dist by hand.']);
        for (const rule of rules) {
            expect(listed).toContain(`[${rule.ulid}] ${rule.text}`);
        }
        expect(listed.indexOf(rules[0]?.ulid ?? '')).toBeLessThan(listed.indexOf(rules[1]?.ulid ?? ''));

        const replaced = await submit(fixture, `elepha:rules:replace ${rules[0]?.ulid} Run the focused test, then the suite.`);
        expect(replaced).toContain(`[${rules[0]?.ulid}] Run the focused test, then the suite.`);
        expect(storedRules(fixture).map((rule) => rule.text)).toEqual([
            'Run the focused test, then the suite.',
            'Never edit dist by hand.',
        ]);

        const removed = await submit(fixture, `elepha:rules:remove ${rules[1]?.ulid}`);
        expect(removed).toContain(`[${rules[1]?.ulid}] Never edit dist by hand.`);
        expect(storedRules(fixture).map((rule) => rule.text)).toEqual(['Run the focused test, then the suite.']);
    });

    it.each(['false', 'throw'])('leaves rules unchanged when a mutation receipt returns %s', async (failure) => {
        const fixture = seededDb('elepha-rules-receipt-failure-', ['Keep this rule.']);
        const before = storedRules(fixture);
        const commands = [
            'elepha:rules:add Another rule.',
            `elepha:rules:remove ${before[0]?.ulid}`,
            `elepha:rules:replace ${before[0]?.ulid} Rewritten rule.`,
        ];
        for (const prompt of commands) {
            const result = await runUserPromptSubmit(payload(fixture.projectPath, prompt), 'codex', {
                dbPath: fixture.dbPath,
                now: () => NOW,
                writeInjection: (store, input) => {
                    store.recordInjection(input);
                    if (failure === 'throw') {
                        throw new Error('Receipt write failed.');
                    }
                    return false;
                },
            });
            expect(result, prompt).toEqual({ reason: 'injection_record_failed' });
            expect(storedRules(fixture), prompt).toEqual(before);
            const db = openUnmanagedDb(fixture.dbPath);
            try {
                expect(db.prepare('SELECT count(*) AS count FROM injections').get(), prompt).toEqual({ count: 0 });
            } finally {
                db.close();
            }
        }
    });

    it('reports each refusal and stores nothing', async () => {
        const fixture = seededDb('elepha-rules-refusals-', ['Only rule.']);
        const [existing] = storedRules(fixture);

        expect(await submit(fixture, 'elepha:rules:add   ')).toContain(STANDING_RULE_REJECTIONS.empty);
        expect(await submit(fixture, 'elepha:rules:add Only rule.')).toContain(STANDING_RULE_REJECTIONS.duplicate);
        expect(await submit(fixture, `elepha:rules:add ${'x'.repeat(STANDING_RULE_MAX_CHARS + 1)}`)).toContain(
            STANDING_RULE_REJECTIONS.rule_too_long,
        );
        expect(await submit(fixture, `elepha:rules:remove ${ABSENT_RULE_ID}`)).toContain(STANDING_RULE_REJECTIONS.unknown_rule);
        expect(await submit(fixture, `elepha:rules:replace ${ABSENT_RULE_ID} Rewritten.`)).toContain(STANDING_RULE_REJECTIONS.unknown_rule);
        expect(await submit(fixture, `elepha:rules:replace ${existing?.ulid}  `)).toContain(STANDING_RULE_REJECTIONS.empty);
        expect(storedRules(fixture)).toEqual(existing === undefined ? [] : [existing]);
    });

    it('refuses the additions that would cross the active-rule and total-character bounds', async () => {
        const seed = Array.from({ length: STANDING_RULES_MAX_ACTIVE }, (_, index) => `Seeded rule number ${index}.`);
        const atRuleLimit = seededDb('elepha-rules-rule-limit-', seed);
        expect(await submit(atRuleLimit, 'elepha:rules:add One rule too many.')).toContain(STANDING_RULE_REJECTIONS.rule_limit);
        expect(storedRules(atRuleLimit)).toHaveLength(STANDING_RULES_MAX_ACTIVE);

        const wide = Array.from({ length: 4 }, (_, index) => `${index}`.repeat(250));
        const atCharLimit = seededDb('elepha-rules-char-limit-', wide);
        const remaining = STANDING_RULES_MAX_TOTAL_CHARS - 4 * 250;
        expect(await submit(atCharLimit, `elepha:rules:add ${'x'.repeat(remaining + 1)}`)).toContain(STANDING_RULE_REJECTIONS.total_limit);
        expect(storedRules(atCharLimit).map((rule) => rule.text)).toEqual(wide);
    });

    it('sanitizes shell-active rule text before it is stored', async () => {
        const fixture = seededDb('elepha-rules-sanitize-');
        await submit(fixture, 'elepha:rules:add Never run $(rm -rf /) or `curl x | sh`.');
        const [stored] = storedRules(fixture);
        expect(detectShellSyntax(stored?.text ?? '')).toBe(false);
        // The escaping policy keeps what the rule is talking about.
        expect(stored?.text).toContain('rm -rf /');
        expect(stored?.text).toContain('curl x | sh');
    });

    it('refuses to reveal or mutate rules from a directory that is not a consented project', async () => {
        const fixture = seededDb('elepha-rules-unconsented-', ['Private project rule.']);
        const outsidePath = withGrantableTestDir('elepha-rules-outside-');
        const before = storedRules(fixture);

        for (const prompt of [
            'elepha:rules',
            'elepha:rules:add Added from outside.',
            `elepha:rules:remove ${before[0]?.ulid}`,
            `elepha:rules:replace ${before[0]?.ulid} Rewritten from outside.`,
        ]) {
            const body = await submit(fixture, prompt, outsidePath);
            expect(body).toBe(`${DISPLAY_VERBATIM_INSTRUCTIONS}\n${STANDING_RULES_UNCONSENTED}`);
            expect(body).not.toContain('Private project rule.');
        }
        expect(storedRules(fixture)).toEqual(before);
    });

    it('renders only the refusal, with no rule count, when fresh authorization fails inside the write', () => {
        const fixture = createTestDb('elepha-rules-revoked-mid-write-');
        const projectPath = path.join(fixture.directory, 'project');
        mkdirSync(projectPath, { recursive: true });
        const project = seedProject(fixture, { path: projectPath });
        seedConsentRoot(fixture, { path: projectPath, state: 'approved' });
        const seeded = fixture.store.standingRules.add(
            { projectIds: [project.id], ownerProjectId: project.id, stillConsented: () => true },
            'Private project rule.',
            ISO,
        );
        expect(seeded.status).toBe('added');

        // An unrelated oversized project row makes stored authorization
        // indeterminate even though live resolution still finds this project.
        // The command must report refusal without reading capacity or writing.
        const unrelated = seedProject(fixture, { path: path.join(fixture.directory, 'unrelated') });
        fixture.db
            .prepare('UPDATE projects SET git_remote = ? WHERE id = ?')
            .run('x'.repeat(PROJECT_AUTHORIZATION_ROW_MAX_BYTES), unrelated.id);

        const capacity = vi.spyOn(fixture.store.standingRules, 'capacity');
        const commands: StandingRulesCommand[] = [
            { kind: 'rules-add', text: 'Added after revocation.' },
            { kind: 'rules-remove', ruleId: ABSENT_RULE_ID },
            { kind: 'rules-replace', ruleId: ABSENT_RULE_ID, text: 'Rewritten after revocation.' },
        ];
        for (const command of commands) {
            const body = standingRulesCommandBody(fixture.db, fixture.store, command, projectPath, ISO);
            expect(body, command.kind).toBe(`${DISPLAY_VERBATIM_INSTRUCTIONS}\n${STANDING_RULE_REJECTIONS.unconsented}`);
            expect(body).not.toContain('Private project rule.');
            // No capacity line, so neither bound reveals how many rules exist.
            expect(body).not.toMatch(/\d+ of \d+/);
        }
        // Reading capacity after a failed authorization would serve memory the
        // caller is no longer entitled to, so the reader is never invoked.
        expect(capacity).not.toHaveBeenCalled();
        expect(fixture.store.standingRules.list([project.id]).map((rule) => rule.text)).toEqual(['Private project rule.']);
    });

    it('returns the locked-memory message without revealing or mutating rules while paranoid mode is locked', async () => {
        const fixture = seededDb('elepha-rules-locked-', ['Private project rule.']);
        const before = storedRules(fixture);
        const lockedConnection = ((dbPath: string) => {
            const db = openUnmanagedDb(dbPath);
            registerParanoidDatabase(db, dbPath, Buffer.alloc(32, 1));
            return db;
        }) as unknown as typeof openDb;

        const locking = openUnmanagedDb(fixture.dbPath);
        locking.prepare("UPDATE paranoid_authority SET enrolled = 1, state = 'locked', generation = generation + 1").run();
        locking.close();

        for (const prompt of [
            'elepha:rules',
            'elepha:rules:add Added while locked.',
            `elepha:rules:remove ${before[0]?.ulid}`,
            `elepha:rules:replace ${before[0]?.ulid} Rewritten while locked.`,
        ]) {
            const result = await runUserPromptSubmit(payload(fixture.projectPath, prompt), 'codex', {
                dbPath: fixture.dbPath,
                openDatabase: lockedConnection,
                now: () => NOW,
            });
            const body = injectedBody(result);
            expect(body).toBe(LOCKED_MEMORY_MESSAGE);
            expect(body).not.toContain('Private project rule.');
        }
        expect(storedRules(fixture)).toEqual(before);
    });

    it('acknowledges a committed command without disclosing its rule when memory locks before the final gate check', async () => {
        const fixture = seededDb('elepha-rules-postcommit-lock-');
        const key = Buffer.alloc(32, 1);
        const passphrase = 'test standing rule gate';
        const setup = openUnmanagedDb(fixture.dbPath);
        registerParanoidDatabase(setup, fixture.dbPath, key);
        enableParanoidMode(setup, passphrase);
        expect(unlockMemory(setup, passphrase)).toBe('unlocked');
        setup.close();

        const managedOpen = ((dbPath: string) => {
            const db = openUnmanagedDb(dbPath);
            registerParanoidDatabase(db, dbPath, key);
            return db;
        }) as unknown as typeof openDb;
        let transitioned = false;
        const result = await runUserPromptSubmit(payload(fixture.projectPath, 'elepha:rules:add Private rule content.'), 'codex', {
            dbPath: fixture.dbPath,
            openDatabase: managedOpen,
            now: () => NOW,
            writeInjection: (store, input) => {
                const recorded = store.recordInjection(input);
                if (!transitioned) {
                    queueMicrotask(() => {
                        expect(store.database.inTransaction).toBe(false);
                        expect(lockMemory(store.database)).toBe('locked');
                        transitioned = true;
                    });
                }
                return recorded;
            },
        });

        expect(transitioned).toBe(true);
        const body = injectedBody(result);
        expect(body).toContain('elepha:rules');
        expect(body).not.toContain('Private rule content.');
        expect(body).not.toMatch(/\d+ of \d+/);
        expect(storedRules(fixture).map((rule) => rule.text)).toEqual(['Private rule content.']);
        const verification = await managedOpen(fixture.dbPath);
        try {
            expect(isMemoryLocked(verification)).toBe(true);
        } finally {
            verification.close();
        }
    });

    it('keeps one native chat isolated between two physical checkouts of the same logical project', async () => {
        const directory = withGrantableTestDir('elepha-rules-checkout-isolation-');
        const checkoutA = path.join(directory, 'checkout-a');
        const checkoutB = path.join(directory, 'checkout-b');
        mkdirSync(checkoutA);
        mkdirSync(checkoutB);
        for (const checkout of [checkoutA, checkoutB]) {
            execFileSync('git', ['-c', 'init.templateDir=/dev/null', 'init', '-q', checkout], { env: fixtureGitEnv() });
        }
        const fixture = createTestDb('elepha-rules-checkout-isolation-db-');
        const first = seedProject(fixture, { path: checkoutA });
        const second = seedProject(fixture, { path: checkoutB });
        fixture.db
            .prepare('UPDATE projects SET git_remote = ? WHERE id IN (?, ?)')
            .run('https://example.test/same-project', first.id, second.id);
        seedConsentRoot(fixture, { path: checkoutA });
        seedConsentRoot(fixture, { path: checkoutB });
        fixture.close();

        const scopeA = { dbPath: fixture.dbPath, projectPath: checkoutA };
        const scopeB = { dbPath: fixture.dbPath, projectPath: checkoutB };
        expect(await submit(scopeA, 'elepha:rules:project:add Shared project rule.')).toContain('Shared project rule.');
        expect(await submit(scopeA, 'elepha:rules:session:add Rule for checkout A.')).toContain('Rule for checkout A.');
        expect(await submit(scopeB, 'elepha:rules:session')).not.toContain('Rule for checkout A.');
        expect(await submit(scopeB, 'elepha:rules:session:add Rule for checkout B.')).toContain('Rule for checkout B.');
        const aAgain = await submit(scopeA, 'elepha:rules');
        expect(aAgain).toContain('Project standing rules (active):');
        expect(aAgain).toContain('Standing rules for this chat in this checkout (active):');
        expect(aAgain).toContain('Shared project rule.');
        expect(aAgain).toContain('Rule for checkout A.');
        expect(aAgain).not.toContain('Rule for checkout B.');
        const bAgain = await submit(scopeB, 'elepha:rules');
        expect(bAgain).toContain('Shared project rule.');
        expect(bAgain).toContain('Rule for checkout B.');
        expect(bAgain).not.toContain('Rule for checkout A.');
        expect(storedSessionRules(scopeA).map((rule) => rule.checkout_anchor)).toEqual([checkoutA, checkoutB]);
        const [projectRule] = storedRules(scopeA);
        if (!projectRule) throw new Error('expected a project rule');
        expect(await submit(scopeB, `elepha:rules:project:replace ${projectRule.ulid} Updated project rule.`)).toContain(
            'Updated project rule.',
        );
        expect(await submit(scopeA, `elepha:rules:project:remove ${projectRule.ulid}`)).toContain('Updated project rule.');
        expect(storedRules(scopeA)).toEqual([]);
    });

    it('creates the first approved owner for a chat rule and reports only the current native chat', async () => {
        const fixture = createTestDb('elepha-rules-first-chat-owner-db-');
        const projectPath = withGrantableTestDir('elepha-rules-first-chat-owner-');
        seedConsentRoot(fixture, { path: projectPath });
        fixture.close();
        const scope = { dbPath: fixture.dbPath, projectPath };
        expect(await submit(scope, 'elepha:rules:session:add Private chat rule.')).toContain('Private chat rule.');
        expect(storedRules(scope)).toEqual([]);
        expect(storedSessionRules(scope)).toMatchObject([{ checkout_anchor: projectPath, native_session_id: 'rules-chat' }]);
        const otherChat = injectedBody(
            await runUserPromptSubmit(payload(projectPath, 'elepha:rules', 'other-chat'), 'codex', {
                dbPath: fixture.dbPath,
                now: () => NOW,
            }),
        );
        expect(otherChat).not.toContain('Private chat rule.');
        expect(otherChat).toContain('No standing rules for this chat in this checkout yet.');
        const [rule] = storedSessionRules(scope);
        if (!rule) throw new Error('expected a chat rule');
        expect(await submit(scope, `elepha:rules:session:replace ${rule.ulid} Updated chat rule.`)).toContain('Updated chat rule.');
        expect(storedSessionRules(scope)[0]?.ulid).toBe(rule.ulid);
        expect(await submit(scope, `elepha:rules:session:remove ${rule.ulid}`)).toContain('Updated chat rule.');
        expect(storedSessionRules(scope)).toEqual([]);
        const db = openUnmanagedDb(fixture.dbPath);
        try {
            expect(db.prepare('SELECT COUNT(*) AS count FROM projects').get()).toEqual({ count: 1 });
        } finally {
            db.close();
        }
    });

    it('uses the caller physical owner for rootless rows sharing one project identity', async () => {
        const directory = withGrantableTestDir('elepha-rules-rootless-isolation-');
        const firstPath = path.join(directory, 'first');
        const nestedPath = path.join(firstPath, 'nested');
        const secondPath = path.join(directory, 'second');
        mkdirSync(nestedPath, { recursive: true });
        mkdirSync(secondPath);
        const fixture = createTestDb('elepha-rules-rootless-isolation-db-');
        const first = seedProject(fixture, { path: firstPath });
        const nested = seedProject(fixture, { path: nestedPath });
        const second = seedProject(fixture, { path: secondPath });
        fixture.db
            .prepare('UPDATE projects SET git_remote = ? WHERE id IN (?, ?, ?)')
            .run('https://example.test/one-project', first.id, nested.id, second.id);
        seedConsentRoot(fixture, { path: firstPath });
        seedConsentRoot(fixture, { path: secondPath });
        fixture.close();
        const firstScope = { dbPath: fixture.dbPath, projectPath: firstPath };
        const secondScope = { dbPath: fixture.dbPath, projectPath: secondPath };
        expect(await submit(firstScope, 'elepha:rules:session:add First rootless rule.')).toContain('First rootless rule.');
        expect(await submit(secondScope, 'elepha:rules:session')).not.toContain('First rootless rule.');
        expect(await submit(secondScope, 'elepha:rules:session:add Second rootless rule.')).toContain('Second rootless rule.');
        expect(await submit(firstScope, 'elepha:rules:session')).not.toContain('Second rootless rule.');
        const nestedScope = { dbPath: fixture.dbPath, projectPath: nestedPath };
        expect(await submit(nestedScope, 'elepha:rules:session')).toContain('First rootless rule.');
        expect(await submit(nestedScope, 'elepha:rules:session')).not.toContain('Second rootless rule.');
        expect(storedSessionRules(firstScope).map((rule) => rule.checkout_anchor)).toEqual([firstPath, secondPath]);
    });

    it('keeps a rootless chat rule reachable after a shallower approved owner joins the set', async () => {
        const directory = withGrantableTestDir('elepha-rules-rootless-anchor-drift-');
        const parentPath = path.join(directory, 'parent');
        const childPath = path.join(parentPath, 'child');
        const siblingPath = path.join(parentPath, 'sibling');
        mkdirSync(childPath, { recursive: true });
        mkdirSync(siblingPath);
        const fixture = createTestDb('elepha-rules-rootless-anchor-drift-db-');
        seedConsentRoot(fixture, { path: parentPath });
        fixture.close();
        const scope = { dbPath: fixture.dbPath, projectPath: childPath };
        expect(await submit(scope, 'elepha:rules:session:add Keep this chat rule.')).toContain('Keep this chat rule.');
        const [saved] = storedSessionRules(scope);
        if (!saved) throw new Error('expected chat rule');
        expect(saved.checkout_anchor).toBe(childPath);
        const db = openUnmanagedDb(fixture.dbPath);
        try {
            new MemoryStore(db).upsertProject(parentPath);
        } finally {
            db.close();
        }
        expect(await submit(scope, 'elepha:rules:session')).toContain('Keep this chat rule.');
        const otherChat = injectedBody(
            await runUserPromptSubmit(payload(childPath, 'elepha:rules:session', 'other-chat'), 'codex', {
                dbPath: fixture.dbPath,
                now: () => NOW,
            }),
        );
        expect(otherChat).not.toContain('Keep this chat rule.');
        expect(await submit(scope, 'elepha:rules:session', siblingPath)).not.toContain('Keep this chat rule.');
        expect(await submit(scope, `elepha:rules:session:remove ${saved.ulid}`)).toContain('Keep this chat rule.');
        expect(storedSessionRules(scope)).toEqual([]);

        const ambiguous = openUnmanagedDb(fixture.dbPath);
        try {
            const owners = ambiguous.prepare('SELECT id, path FROM projects WHERE path IN (?, ?)').all(parentPath, childPath) as Array<{
                id: number;
                path: string;
            }>;
            const insert = ambiguous.prepare(
                `INSERT INTO session_rules (ulid, tool, native_session_id, checkout_anchor, owner_project_id, text, created_at)
                 VALUES (?, 'codex', 'rules-chat', ?, ?, ?, ?)`,
            );
            for (const owner of owners) {
                insert.run(
                    owner.path === parentPath ? `01J${'1'.repeat(23)}` : `01J${'2'.repeat(23)}`,
                    owner.path,
                    owner.id,
                    owner.path,
                    ISO,
                );
            }
        } finally {
            ambiguous.close();
        }
        const unresolved = await submit(scope, 'elepha:rules:session');
        expect(unresolved).toContain(SESSION_RULES_ANCHOR_AMBIGUOUS);
        expect(await submit(scope, `elepha:rules:session:remove 01J${'2'.repeat(23)}`)).toContain(SESSION_RULES_ANCHOR_AMBIGUOUS);
        expect(storedSessionRules(scope)).toHaveLength(2);
        const logs: string[] = [];
        const result = await runSessionStart(
            JSON.stringify({
                session_id: 'rules-chat',
                cwd: childPath,
                hook_event_name: 'SessionStart',
                source: 'startup',
                model: 'test',
                permission_mode: 'default',
            }),
            'codex',
            {
                dbPath: fixture.dbPath,
                now: () => NOW,
                daemonHealth: () => ({ state: 'RUNNING', healthy: true }),
                readUpdateAvailable: () => undefined,
                log: (line) => logs.push(line),
            },
        );
        expect(result).toEqual({ reason: SESSION_RULES_AMBIGUOUS });
        expect(logs).toContain(`session-start codex source=startup session_id=rules-chat: skipped reason=${SESSION_RULES_AMBIGUOUS}`);
        expect(await submit(scope, 'elepha:rules:project:add Keep the project rule.')).toContain('Keep the project rule.');
        const projectDelivery = await runSessionStart(
            JSON.stringify({
                session_id: 'rules-chat',
                cwd: childPath,
                hook_event_name: 'SessionStart',
                source: 'startup',
                model: 'test',
                permission_mode: 'default',
            }),
            'codex',
            {
                dbPath: fixture.dbPath,
                now: () => NOW,
                daemonHealth: () => ({ state: 'RUNNING', healthy: true }),
                readUpdateAvailable: () => undefined,
                log: (line) => logs.push(line),
            },
        );
        expect(projectDelivery).toHaveProperty('output');
        expect(JSON.stringify(projectDelivery)).toContain('Keep the project rule.');
        expect(JSON.stringify(projectDelivery)).not.toContain(`- ${parentPath}`);
        expect(logs.filter((line) => line.includes(`skipped reason=${SESSION_RULES_AMBIGUOUS}`))).toHaveLength(2);
    });

    it('rechecks the chosen chat anchor inside the write transaction', async () => {
        const directory = withGrantableTestDir('elepha-rules-anchor-race-');
        const parentPath = path.join(directory, 'parent');
        const childPath = path.join(parentPath, 'child');
        mkdirSync(childPath, { recursive: true });
        const fixture = createTestDb('elepha-rules-anchor-race-db-');
        seedConsentRoot(fixture, { path: parentPath });
        fixture.close();
        const scope = { dbPath: fixture.dbPath, projectPath: childPath };
        await submit(scope, 'elepha:rules:session:add Original child rule.');
        const db = openUnmanagedDb(fixture.dbPath);
        try {
            new MemoryStore(db).upsertProject(parentPath);
        } finally {
            db.close();
        }
        const originalAdd = SessionRulesStore.prototype.add;
        const add = vi.spyOn(SessionRulesStore.prototype, 'add').mockImplementation(function (
            this: SessionRulesStore,
            sessionScope,
            text,
            now,
        ) {
            const transactionDb = (this as unknown as { db: ReturnType<typeof openUnmanagedDb> }).db;
            const parentOwner = transactionDb.prepare('SELECT id FROM projects WHERE path = ?').get(parentPath) as { id: number };
            transactionDb
                .prepare(
                    `INSERT INTO session_rules (ulid, tool, native_session_id, checkout_anchor, owner_project_id, text, created_at)
                 VALUES (?, 'codex', 'rules-chat', ?, ?, ?, ?)`,
                )
                .run(`01J${'3'.repeat(23)}`, parentPath, parentOwner.id, 'Competing parent rule.', ISO);
            return originalAdd.call(this, sessionScope, text, now);
        });
        try {
            expect(await submit(scope, 'elepha:rules:session:add Must not fragment.')).toContain('authorization changed');
        } finally {
            add.mockRestore();
        }
        expect(storedSessionRules(scope).map((rule) => rule.text)).toEqual(['Original child rule.', 'Competing parent rule.']);
    });

    it('refuses chat rules outside consent and under a denied physical Git root', async () => {
        const fixture = seededDb('elepha-rules-chat-consent-');
        expect(await submit(fixture, 'elepha:rules:session:add Private chat rule.')).toContain('Private chat rule.');
        const outside = withGrantableTestDir('elepha-rules-chat-outside-');
        for (const prompt of ['elepha:rules', 'elepha:rules:session', 'elepha:rules:session:add Must not save.']) {
            const body = await submit(fixture, prompt, outside);
            expect(body).toBe(`${DISPLAY_VERBATIM_INSTRUCTIONS}\n${STANDING_RULES_UNCONSENTED}`);
            expect(body).not.toContain('Private chat rule.');
        }

        const directory = withGrantableTestDir('elepha-rules-chat-denied-root-');
        const repo = path.join(directory, 'repo');
        const child = path.join(repo, 'allowed');
        mkdirSync(child, { recursive: true });
        execFileSync('git', ['-c', 'init.templateDir=/dev/null', 'init', '-q', repo], { env: fixtureGitEnv() });
        const rootFixture = createTestDb('elepha-rules-chat-denied-root-db-');
        seedConsentRoot(rootFixture, { path: child });
        seedConsentRoot(rootFixture, { path: repo, state: 'denied' });
        rootFixture.close();
        expect(await submit({ dbPath: rootFixture.dbPath, projectPath: child }, 'elepha:rules:session:add Must not cross root.')).toContain(
            STANDING_RULES_UNCONSENTED,
        );
        expect(storedSessionRules(fixture).map((rule) => rule.text)).toEqual(['Private chat rule.']);
    });

    it('does not read or mutate chat rules from an OpenCode hook without verified parentage', async () => {
        const fixture = seededDb('elepha-rules-opencode-unverified-');
        const scope = { dbPath: fixture.dbPath, projectPath: fixture.projectPath };
        expect(await submit(scope, 'elepha:rules:session:add Private chat rule.')).toContain('Private chat rule.');
        const before = storedSessionRules(scope);
        const [saved] = before;
        if (!saved) throw new Error('expected a chat rule');
        const openCodePayload = (prompt: string) =>
            JSON.stringify({
                session_id: 'rules-chat',
                cwd: fixture.projectPath,
                hook_event_name: 'UserPromptSubmit',
                prompt,
            });
        for (const prompt of [
            'elepha:rules:session',
            'elepha:rules:session:add Must not save.',
            `elepha:rules:session:remove ${saved.ulid}`,
            `elepha:rules:session:replace ${saved.ulid} Must not replace.`,
        ]) {
            expect(
                injectedBody(
                    await runUserPromptSubmit(openCodePayload(prompt), 'opencode', {
                        dbPath: fixture.dbPath,
                        now: () => NOW,
                    }),
                ),
            ).toContain(SESSION_RULES_CONTEXT_UNVERIFIED);
        }
        const report = injectedBody(
            await runUserPromptSubmit(openCodePayload('elepha:rules'), 'opencode', {
                dbPath: fixture.dbPath,
                now: () => NOW,
            }),
        );
        expect(report).toContain('Standing rules for this chat in this checkout (unavailable):');
        expect(report).not.toContain('Private chat rule.');
        expect(report).not.toMatch(/Chat standing rules: \d+ of \d+/);
        expect(storedSessionRules(scope)).toEqual(before);
        expect(
            injectedBody(
                await runUserPromptSubmit(openCodePayload('elepha:rules:project'), 'opencode', {
                    dbPath: fixture.dbPath,
                    now: () => NOW,
                }),
            ),
        ).toContain(STANDING_RULES_EMPTY);
    });

    it('serves and manages chat rules only for a host-verified top-level OpenCode chat', async () => {
        const fixture = seededDb('elepha-rules-opencode-root-', ['Shared project rule.']);
        const scope = { dbPath: fixture.dbPath, projectPath: fixture.projectPath };
        const openCodePayload = (prompt: string, sessionId: string, root: boolean) =>
            JSON.stringify({
                session_id: sessionId,
                cwd: fixture.projectPath,
                hook_event_name: 'UserPromptSubmit',
                prompt,
                ...(root ? { session_root: true } : {}),
            });
        const command = async (prompt: string, sessionId = 'root-chat', root = true) =>
            injectedBody(
                await runUserPromptSubmit(openCodePayload(prompt, sessionId, root), 'opencode', { dbPath: fixture.dbPath, now: () => NOW }),
            );
        const logs: string[] = [];
        const delivered = async (sessionId: string, root: boolean) => {
            const result = await runStandingRulesHook(
                JSON.stringify({ session_id: sessionId, cwd: fixture.projectPath, ...(root ? { session_root: true } : {}) }),
                { dbPath: fixture.dbPath, now: () => NOW, log: (line) => logs.push(line) },
            );
            if (!('context' in result)) throw new Error(`rules were not delivered: ${result.reason}`);
            return result.context;
        };

        expect(await command('elepha:rules:session:add Root chat rule.')).toContain('Root chat rule.');
        const [saved] = storedSessionRules(scope);
        if (!saved) throw new Error('expected a chat rule');
        expect(saved).toMatchObject({ tool: 'opencode', native_session_id: 'root-chat', checkout_anchor: fixture.projectPath });
        const report = await command('elepha:rules');
        expect(report).toContain('Shared project rule.');
        expect(report).toContain('Standing rules for this chat in this checkout (active):');
        expect(report).toContain('Root chat rule.');

        const rootContext = await delivered('root-chat', true);
        expect(rootContext).toContain('Shared project rule.');
        expect(rootContext).toContain('Root chat rule.');

        // A child, a sibling and an unverified lookup of the root id all keep
        // project rules but receive no chat authority.
        for (const [sessionId, root] of [
            ['root-chat', false],
            ['child-chat', false],
            ['sibling-chat', true],
        ] as const) {
            const context = await delivered(sessionId, root);
            expect(context, sessionId).toContain('Shared project rule.');
            expect(context, sessionId).not.toContain('Root chat rule.');
        }
        for (const prompt of [
            'elepha:rules:session',
            'elepha:rules:session:add Must not save.',
            `elepha:rules:session:remove ${saved.ulid}`,
            `elepha:rules:session:replace ${saved.ulid} Must not replace.`,
        ]) {
            expect(await command(prompt, 'root-chat', false), prompt).toContain(SESSION_RULES_CONTEXT_UNVERIFIED);
            expect(await command(prompt, 'child-chat', false), prompt).toContain(SESSION_RULES_CONTEXT_UNVERIFIED);
        }
        const sibling = await command('elepha:rules', 'sibling-chat');
        expect(sibling).toContain('Shared project rule.');
        expect(sibling).not.toContain('Root chat rule.');
        expect(await command(`elepha:rules:session:remove ${saved.ulid}`, 'sibling-chat')).toContain(
            'No standing rule with that id belongs to this chat in this checkout.',
        );
        expect(storedSessionRules(scope)).toEqual([saved]);
        // The same native id from another tool is another chat.
        expect(
            injectedBody(
                await runUserPromptSubmit(payload(fixture.projectPath, 'elepha:rules:session', 'root-chat'), 'codex', {
                    dbPath: fixture.dbPath,
                    now: () => NOW,
                }),
            ),
        ).not.toContain('Root chat rule.');

        expect(await command(`elepha:rules:session:replace ${saved.ulid} Updated root rule.`)).toContain('Updated root rule.');
        expect(await command(`elepha:rules:session:remove ${saved.ulid}`)).toContain('Updated root rule.');
        expect(storedSessionRules(scope)).toEqual([]);
        expect(logs.join('\n')).not.toMatch(/root-chat|child-chat|sibling-chat|Root chat rule|Shared project rule/);
    });

    it.each([false, 'true', 1, null])('rejects a malformed OpenCode session_root claim: %j', async (value) => {
        const fixture = seededDb('elepha-rules-opencode-root-claim-');
        const openDatabase = vi.fn(openDb);
        const dependencies = { dbPath: fixture.dbPath, now: () => NOW, openDatabase: openDatabase as unknown as typeof openDb };
        expect(
            await runUserPromptSubmit(
                JSON.stringify({
                    session_id: 'root-chat',
                    cwd: fixture.projectPath,
                    hook_event_name: 'UserPromptSubmit',
                    prompt: 'elepha:rules:session:add Must not save.',
                    session_root: value,
                }),
                'opencode',
                dependencies,
            ),
        ).toEqual({ reason: 'invalid_payload' });
        expect(parseStandingRulesPayload(JSON.stringify({ session_id: 'root-chat', cwd: fixture.projectPath, session_root: value }))).toBe(
            undefined,
        );
        expect(openDatabase).not.toHaveBeenCalled();
        expect(storedSessionRules(fixture)).toEqual([]);
    });

    it('rolls back first-owner creation and existing chat mutations when the receipt fails', async () => {
        const first = createTestDb('elepha-rules-chat-first-receipt-db-');
        const projectPath = withGrantableTestDir('elepha-rules-chat-first-receipt-');
        seedConsentRoot(first, { path: projectPath });
        first.close();
        const failedReceipt = (store: MemoryStore, input: Parameters<MemoryStore['recordInjection']>[0]) => {
            store.recordInjection(input);
            return false;
        };
        expect(
            await runUserPromptSubmit(payload(projectPath, 'elepha:rules:session:add No owner.'), 'codex', {
                dbPath: first.dbPath,
                now: () => NOW,
                writeInjection: failedReceipt,
            }),
        ).toEqual({ reason: 'injection_record_failed' });
        const empty = openUnmanagedDb(first.dbPath);
        try {
            expect(empty.prepare('SELECT COUNT(*) AS count FROM projects').get()).toEqual({ count: 0 });
            expect(empty.prepare('SELECT COUNT(*) AS count FROM session_rules').get()).toEqual({ count: 0 });
        } finally {
            empty.close();
        }

        const fixture = seededDb('elepha-rules-chat-receipt-');
        await submit(fixture, 'elepha:rules:session:add Keep this rule.');
        const [saved] = storedSessionRules(fixture);
        if (!saved) throw new Error('expected a chat rule');
        for (const prompt of [
            'elepha:rules:session:add Another rule.',
            `elepha:rules:session:replace ${saved.ulid} Changed.`,
            `elepha:rules:session:remove ${saved.ulid}`,
        ]) {
            expect(
                await runUserPromptSubmit(payload(fixture.projectPath, prompt), 'codex', {
                    dbPath: fixture.dbPath,
                    now: () => NOW,
                    writeInjection: failedReceipt,
                }),
            ).toEqual({ reason: 'injection_record_failed' });
            expect(storedSessionRules(fixture)).toEqual([saved]);
        }
    });
});
