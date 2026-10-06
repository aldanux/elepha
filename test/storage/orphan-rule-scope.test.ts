import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ORPHAN_NATIVE_RULE_MAX_ROWS } from '../../src/config/orphan-cleanup.js';
import type { PurgePlan } from '../../src/storage/memory-store.js';
import { createTestDb, seedMemory, seedProject, seedSession } from '../helpers/db.js';
import { expectLiveMemoryCurrent } from '../helpers/live-memory.js';

function fixture(tool: 'claude-code' | 'codex') {
    const f = createTestDb('orphan-rule-scope-');
    const project = seedProject(f, { path: path.join(f.directory, 'deleted') });
    const session = seedSession(f, { project, tool, nativeId: 'candidate' });
    seedMemory(f, { project, session, durableCapture: true });
    const addChatRule = (nativeId: string, anchor = project.path, owner = project.id, host = tool) => {
        const result = f.db
            .prepare(`INSERT INTO session_rules
            (ulid, tool, native_session_id, checkout_anchor, owner_project_id, text, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)`)
            .run(`${host}-${nativeId}-${anchor}`, host, nativeId, anchor, owner, `rule for ${nativeId}`, '2026-10-01');
        return Number(result.lastInsertRowid);
    };
    f.db
        .prepare('INSERT INTO standing_rules(ulid, project_id, text, created_at) VALUES (?, ?, ?, ?)')
        .run('project-rule', project.id, 'preserve project policy', '2026-10-01');
    const candidateRule = addChatRule(session.native_id);
    const assertIntact = (plan: PurgePlan) => {
        expect(f.store.listMemoriesForSession(session.id)).toHaveLength(1);
        expect(f.store.isTranscriptPurged(tool, session.native_id)).toBe(false);
        expect(f.db.prepare('SELECT id FROM session_rules WHERE id = ?').get(candidateRule)).toBeDefined();
        expect(f.store.standingRules.list([project.id])).toHaveLength(1);
        expect(plan.sessions.map((s) => s.id)).toEqual([session.id]);
        expectLiveMemoryCurrent(f.db);
    };
    return { ...f, project, session, addChatRule, candidateRule, assertIntact };
}

for (const tool of ['claude-code', 'codex'] as const) {
    describe(`${tool} orphan chat rule scope`, () => {
        it.each(['existing', 'unresolved'] as const)(
            'preserves a different rule-only chat and owner policy with an %s checkout',
            (state) => {
                const f = fixture(tool);
                const anchor = path.join(f.directory, 'other-checkout');
                if (state === 'existing') mkdirSync(anchor);
                else writeFileSync(anchor, 'not a directory');
                const otherRule = f.addChatRule('rule-only-chat', anchor);
                // An identical native ID on the other host is also a different chat.
                const otherHostRule = f.addChatRule('candidate', anchor, f.project.id, tool === 'codex' ? 'claude-code' : 'codex');
                const plan = f.store.planPurge({ orphan: true });
                expect(plan.sessionRules.map((r) => r.id)).toEqual([f.candidateRule]);
                expect(plan.standingRules).toEqual([]);
                expect(plan.emptiedProjects).toEqual([]);
                f.store.applyPurgePlan(plan);
                expect(f.store.listMemoriesForSession(f.session.id)).toEqual([]);
                expect(f.db.prepare('SELECT id FROM session_rules ORDER BY id').all()).toEqual([{ id: otherRule }, { id: otherHostRule }]);
                expect(f.store.getProjectById(f.project.id)).toBeDefined();
                expect(f.store.standingRules.list([f.project.id])).toHaveLength(1);
                expectLiveMemoryCurrent(f.db);
            },
        );

        it('removes all verified candidate chat rules, including associations owned outside the captured project', () => {
            const f = fixture(tool);
            const otherOwner = seedProject(f, { path: path.join(f.directory, 'other-deleted') });
            const otherRule = f.addChatRule('candidate', otherOwner.path, otherOwner.id);
            const plan = f.store.planPurge({ orphan: true });
            expect(plan.sessionRules.map((r) => r.id)).toEqual([f.candidateRule, otherRule]);
            f.store.applyPurgePlan(plan);
            expect(f.db.prepare('SELECT * FROM session_rules').all()).toEqual([]);
            expect(f.store.isTranscriptPurged(tool, 'candidate')).toBe(true);
            expectLiveMemoryCurrent(f.db);
        });

        it('preserves the unit if any candidate rule association has a protected checkout', () => {
            const f = fixture(tool);
            const live = path.join(f.directory, 'live');
            mkdirSync(live);
            f.addChatRule('candidate', live);
            const plan = f.store.planPurge({ orphan: true });
            expect(plan.sessions).toEqual([]);
            expect(plan.sessionRules).toEqual([]);
            expect(f.store.listMemoriesForSession(f.session.id)).toHaveLength(1);
        });

        it.each(['recorded-root', 'budget'] as const)(
            'preserves candidate memory when complete rule inspection finds %s protection',
            (protection) => {
                const f = fixture(tool);
                const otherOwner = seedProject(f, { path: path.join(f.directory, 'other-deleted') });
                const anchor = path.join(f.directory, 'historical-anchor');
                f.addChatRule('candidate', anchor, otherOwner.id);
                if (protection === 'recorded-root') {
                    const liveRoot = path.join(f.directory, 'live-root');
                    mkdirSync(liveRoot);
                    f.db.prepare('UPDATE projects SET git_root = ? WHERE id = ?').run(liveRoot, otherOwner.id);
                }

                if (protection === 'budget') {
                    for (let i = 0; i < ORPHAN_NATIVE_RULE_MAX_ROWS; i++) f.addChatRule('candidate', path.join(f.directory, `anchor-${i}`));
                }
                const plan = f.store.planPurge({ orphan: true });
                expect(plan.sessions).toEqual([]);
                expect(plan.sessionRules).toEqual([]);
                expect(f.store.listMemoriesForSession(f.session.id)).toHaveLength(1);
                expect(f.store.isTranscriptPurged(tool, 'candidate')).toBe(false);
            },
        );

        it.each(['remaining-anchor', 'new-rule', 'candidate-owner', 'outside-owner-rule', 'directory'] as const)(
            'invalidates preview after %s changes without partial deletion',
            (change) => {
                const f = fixture(tool);
                const otherOwner = seedProject(f, { path: path.join(f.directory, 'other-deleted') });
                const anchor = path.join(f.directory, 'historical-anchor');
                const outsideRule = f.addChatRule('candidate', anchor, otherOwner.id);
                const remaining = f.addChatRule('remaining', path.join(f.directory, 'absent-other'));
                const plan = f.store.planPurge({ orphan: true });
                if (change === 'remaining-anchor')
                    f.db
                        .prepare('UPDATE session_rules SET checkout_anchor = ? WHERE id = ?')
                        .run(path.join(f.directory, 'changed'), remaining);
                if (change === 'new-rule') f.addChatRule('new-chat');
                if (change === 'candidate-owner')
                    f.db.prepare('UPDATE session_rules SET owner_project_id = ? WHERE id = ?').run(otherOwner.id, f.candidateRule);
                if (change === 'outside-owner-rule') f.addChatRule('outside-chat', otherOwner.path, otherOwner.id);
                if (change === 'directory') mkdirSync(otherOwner.path);

                expect(() => f.store.applyPurgePlan(plan)).toThrow(/changed|aborted/);
                f.assertIntact(plan);
                expect(f.db.prepare('SELECT id FROM session_rules WHERE id = ?').get(outsideRule)).toBeDefined();
            },
        );

        it('rolls back captured content, standing rules and tombstones when chat-rule deletion fails', () => {
            const f = fixture(tool);
            const plan = f.store.planPurge({ orphan: true });
            f.db.exec(
                "CREATE TRIGGER reject_chat_rule_delete BEFORE DELETE ON session_rules BEGIN SELECT RAISE(ABORT, 'chat-rule deletion failure'); END",
            );
            expect(() => f.store.applyPurgePlan(plan)).toThrow('chat-rule deletion failure');
            f.assertIntact(plan);
        });

        it('rejects expansion of the confirmed chat-rule scope', () => {
            const f = fixture(tool);
            const live = path.join(f.directory, 'live');
            mkdirSync(live);
            const otherRule = f.addChatRule('other-chat', live);
            const plan = f.store.planPurge({ orphan: true });
            const row = f.db.prepare('SELECT * FROM session_rules WHERE id = ?').get(otherRule) as (typeof plan.sessionRules)[number];
            plan.sessionRules.push({ ...row, projectPath: f.project.path });
            expect(() => f.store.applyPurgePlan(plan)).toThrow(/changed|aborted/);
            f.assertIntact(plan);
            expect(f.db.prepare('SELECT id FROM session_rules WHERE id = ?').get(otherRule)).toBeDefined();
        });

        it('keeps time-filtered rule scope intact while validating all candidate rule owners', () => {
            const f = fixture(tool);
            const otherOwner = seedProject(f, { path: path.join(f.directory, 'other-deleted') });
            f.addChatRule('candidate', otherOwner.path, otherOwner.id);
            const plan = f.store.planPurge({ orphan: true, olderThan: '9999-01-01' });
            expect(plan.sessionRules).toEqual([]);
            expect(plan.standingRules).toEqual([]);
            f.assertIntact(plan);
            f.store.applyPurgePlan(plan);
            expect(f.db.prepare('SELECT id FROM session_rules').all()).toHaveLength(2);
            expect(f.store.standingRules.list([f.project.id])).toHaveLength(1);
            expectLiveMemoryCurrent(f.db);
        });

        it('keeps explicit whole-project purge semantics for rule-only chats and standing rules', () => {
            const f = fixture(tool);
            const live = path.join(f.directory, 'live');
            mkdirSync(live);
            const otherRule = f.addChatRule('rule-only-chat', live);
            const plan = f.store.planPurge({ projectIds: [f.project.id], deleteStandingRules: true });
            expect(plan.sessionRules.map((r) => r.id)).toEqual([f.candidateRule, otherRule]);
            expect(plan.standingRules).toHaveLength(1);
            f.store.applyPurgePlan(plan);
            expect(f.db.prepare('SELECT * FROM session_rules').all()).toEqual([]);
            expect(f.store.getProjectById(f.project.id)).toBeUndefined();
            expectLiveMemoryCurrent(f.db);
        });
    });
}
