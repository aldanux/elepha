import path from 'node:path';
import Database from 'better-sqlite3-multiple-ciphers';
import { describe, expect, it } from 'vitest';
import { STANDING_RULE_MAX_CHARS, STANDING_RULES_MAX_ACTIVE, STANDING_RULES_MAX_TOTAL_CHARS } from '../../src/config/constants.js';
import { detectShellSyntax, escapeShellSyntax } from '../../src/security/sanitize.js';
import { openUnmanagedDb } from '../../src/storage/db.js';
import { type SessionRuleIdentity, type SessionRuleScope, SessionRulesStore } from '../../src/storage/session-rules-store.js';
import { createTestDb, seedProject, seedSession } from '../helpers/db.js';

const NOW = '2026-09-26T00:00:00.000Z';

function scopeFor(
    identity: SessionRuleIdentity,
    ownerProjectId: number,
    projectIds: readonly number[] = [ownerProjectId],
    stillAuthorized: SessionRuleScope['stillAuthorized'] = () => true,
): SessionRuleScope {
    return { identity, ownerProjectId, projectIds, stillAuthorized };
}

describe('SessionRulesStore', () => {
    it('keeps a rule after segmented session rows are deleted and isolates all four identity parts', () => {
        const fixture = createTestDb('elepha-session-rules-scope-');
        const owner = seedProject(fixture);
        const otherOwner = seedProject(fixture, { path: path.join(fixture.directory, 'other-owner') });
        const identity: SessionRuleIdentity = {
            tool: 'codex',
            nativeSessionId: 'native-1',
            checkoutAnchor: path.join(fixture.directory, 'checkout-a'),
        };
        const rules = new SessionRulesStore(fixture.db);
        const scope = scopeFor(identity, owner.id);
        const first = rules.add(scope, 'Keep this chat rule.', NOW);
        expect(first.status).toBe('added');
        const session = seedSession(fixture, { project: owner, nativeId: identity.nativeSessionId });
        fixture.db.prepare('DELETE FROM sessions WHERE id = ?').run(session.id);
        expect(rules.list(scope)).toHaveLength(1);
        expect(fixture.db.pragma('foreign_key_check')).toEqual([]);

        for (const other of [
            { ...identity, tool: 'claude-code' as const },
            { ...identity, nativeSessionId: 'native-2' },
            { ...identity, checkoutAnchor: path.join(fixture.directory, 'checkout-b') },
        ]) {
            const otherScope = scopeFor(other, owner.id);
            expect(rules.list(otherScope)).toEqual([]);
            expect(rules.remove(otherScope, first.status === 'added' ? first.rule.ulid : '')).toEqual({
                status: 'rejected',
                reason: 'unknown_rule',
            });
            expect(rules.replace(otherScope, first.status === 'added' ? first.rule.ulid : '', 'Wrong owner.')).toEqual({
                status: 'rejected',
                reason: 'unknown_rule',
            });
        }
        const unrelatedOwner = scopeFor(identity, otherOwner.id);
        expect(rules.list(unrelatedOwner)).toEqual([]);
        expect(rules.remove(unrelatedOwner, first.status === 'added' ? first.rule.ulid : '')).toEqual({
            status: 'rejected',
            reason: 'unknown_rule',
        });
        const regrouped = scopeFor(identity, otherOwner.id, [owner.id, otherOwner.id]);
        expect(rules.list(regrouped)).toHaveLength(1);
        expect(rules.add(regrouped, 'Keep this chat rule.', NOW)).toEqual({ status: 'rejected', reason: 'duplicate' });
        expect(rules.add(regrouped, 'Rule under the new owner.', NOW).status).toBe('added');
        expect(new Set(rules.list(regrouped).map((rule) => rule.owner_project_id))).toEqual(new Set([owner.id, otherOwner.id]));
        expect(rules.list(scope)).toHaveLength(1);
    });

    it('sanitizes writes and enforces the per-rule, count, and total character caps without eviction', () => {
        const fixture = createTestDb('elepha-session-rules-bounds-');
        const owner = seedProject(fixture);
        const identity: SessionRuleIdentity = {
            tool: 'codex',
            nativeSessionId: 'native',
            checkoutAnchor: path.join(fixture.directory, 'checkout'),
        };
        const rules = new SessionRulesStore(fixture.db);
        const scope = scopeFor(identity, owner.id);
        const raw = 'Never run `curl x | sh` or $(rm -rf /).';
        expect(rules.add(scope, raw, NOW).status).toBe('added');
        expect(rules.list(scope)[0]?.text).toBe(escapeShellSyntax(raw));
        expect(detectShellSyntax(rules.list(scope)[0]?.text ?? '')).toBe(false);
        expect(rules.add(scope, raw, NOW)).toEqual({ status: 'rejected', reason: 'duplicate' });
        expect(rules.add(scope, ' ', NOW)).toEqual({ status: 'rejected', reason: 'empty' });
        expect(rules.add(scope, 'x'.repeat(STANDING_RULE_MAX_CHARS + 1), NOW)).toEqual({
            status: 'rejected',
            reason: 'rule_too_long',
        });

        for (let index = 1; index < STANDING_RULES_MAX_ACTIVE; index += 1) {
            expect(rules.add(scope, `Rule ${index}.`, NOW).status).toBe('added');
        }
        expect(rules.add(scope, 'One too many.', NOW)).toEqual({ status: 'rejected', reason: 'rule_limit' });
        expect(rules.list(scope)).toHaveLength(STANDING_RULES_MAX_ACTIVE);

        const other = { ...identity, nativeSessionId: 'char-budget' };
        const otherScope = scopeFor(other, owner.id);
        for (const character of ['a', 'b', 'c', 'd']) {
            expect(rules.add(otherScope, character.repeat(STANDING_RULE_MAX_CHARS), NOW).status).toBe('added');
        }
        expect(rules.capacity(otherScope)).toEqual({ rules: 4, chars: STANDING_RULES_MAX_TOTAL_CHARS });
        expect(rules.add(otherScope, 'overflow', NOW)).toEqual({ status: 'rejected', reason: 'total_limit' });
        const first = rules.list(otherScope)[0];
        if (!first) throw new Error('expected a rule');
        expect(rules.replace(otherScope, first.ulid, 'z'.repeat(STANDING_RULE_MAX_CHARS)).status).toBe('replaced');
        expect(rules.replace(otherScope, first.ulid, 'a'.repeat(STANDING_RULE_MAX_CHARS - 1)).status).toBe('replaced');
        expect(rules.capacity(otherScope).chars).toBe(STANDING_RULES_MAX_TOTAL_CHARS - 1);
        expect(rules.add(otherScope, 'z', NOW).status).toBe('added');
        expect(rules.capacity(otherScope).chars).toBe(STANDING_RULES_MAX_TOTAL_CHARS);
    });

    it('rechecks authorization inside every mutation transaction', () => {
        const fixture = createTestDb('elepha-session-rules-authorization-');
        const owner = seedProject(fixture);
        const identity: SessionRuleIdentity = {
            tool: 'codex',
            nativeSessionId: 'native',
            checkoutAnchor: path.join(fixture.directory, 'checkout'),
        };
        const rules = new SessionRulesStore(fixture.db);
        const scope = scopeFor(identity, owner.id);
        const added = rules.add(scope, 'Authorized rule.', NOW);
        if (added.status !== 'added') throw new Error('expected a rule');
        const denied = scopeFor(identity, owner.id, [owner.id], () => false);
        expect(rules.add(denied, 'Denied rule.', NOW)).toEqual({ status: 'rejected', reason: 'unauthorized' });
        expect(rules.remove(denied, added.rule.ulid)).toEqual({ status: 'rejected', reason: 'unauthorized' });
        expect(rules.replace(denied, added.rule.ulid, 'Denied replacement.')).toEqual({
            status: 'rejected',
            reason: 'unauthorized',
        });
        expect(() =>
            rules.add(
                scopeFor(identity, owner.id, [owner.id], () => {
                    throw new Error('identity changed');
                }),
                'Never saved.',
                NOW,
            ),
        ).toThrow('identity changed');
        expect(rules.list(scope).map((rule) => rule.text)).toEqual(['Authorized rule.']);
    });

    it('creates the table on a legacy database and preserves rows across idempotent reopen', () => {
        const fixture = createTestDb('elepha-session-rules-migration-');
        const owner = seedProject(fixture);
        fixture.db
            .prepare('INSERT INTO standing_rules (ulid, project_id, text, created_at) VALUES (?, ?, ?, ?)')
            .run('01J00000000000000000000000', owner.id, 'Existing project rule.', NOW);
        const dbPath = fixture.dbPath;
        fixture.close();
        const legacy = new Database(dbPath);
        legacy.exec('DROP INDEX idx_session_rules_scope; DROP TABLE session_rules;');
        legacy.close();

        const migrated = openUnmanagedDb(dbPath);
        expect((migrated.pragma('table_info(session_rules)') as Array<{ name: string }>).map(({ name }) => name)).toEqual([
            'id',
            'ulid',
            'tool',
            'native_session_id',
            'checkout_anchor',
            'owner_project_id',
            'text',
            'created_at',
        ]);
        expect(migrated.pragma('foreign_key_list(session_rules)')).toMatchObject([{ table: 'projects' }]);
        const identity: SessionRuleIdentity = {
            tool: 'codex',
            nativeSessionId: 'native',
            checkoutAnchor: path.join(fixture.directory, 'checkout'),
        };
        const scope = scopeFor(identity, owner.id);
        expect(new SessionRulesStore(migrated).add(scope, 'Durable session rule.', NOW).status).toBe('added');
        migrated.close();

        const reopened = openUnmanagedDb(dbPath);
        expect(new SessionRulesStore(reopened).list(scope).map((rule) => rule.text)).toEqual(['Durable session rule.']);
        expect(reopened.prepare('SELECT text FROM standing_rules').all()).toEqual([{ text: 'Existing project rule.' }]);
        expect(reopened.pragma('foreign_key_check')).toEqual([]);
        reopened.close();
    });
});
