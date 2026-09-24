import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { STANDING_RULE_MAX_CHARS, STANDING_RULES_MAX_ACTIVE, STANDING_RULES_MAX_TOTAL_CHARS } from '../../src/config/constants.js';
import { detectShellSyntax, escapeShellSyntax } from '../../src/security/sanitize.js';
import type { ProjectRow } from '../../src/storage/memory-store.js';
import type { StandingRuleScope } from '../../src/storage/standing-rules-store.js';
import { newUlid } from '../../src/storage/ulid.js';
import { createTestDb, seedProject, type TestDatabase } from '../helpers/db.js';

const NOW = '2026-09-20T00:00:00.000Z';

function scopeFor(projects: readonly ProjectRow[], stillConsented: (projectId: number) => boolean = () => true): StandingRuleScope {
    const [owner] = projects;
    if (!owner) {
        throw new Error('a scope needs at least one project row');
    }
    return { projectIds: projects.map((project) => project.id), ownerProjectId: owner.id, stillConsented };
}

// Two project rows for one checkout, the shape the resolver produces when the
// same repository was captured from a subdirectory as well as its root.
function twoRowProject(fixture: TestDatabase): ProjectRow[] {
    const root = seedProject(fixture, { path: path.join(fixture.directory, 'checkout') });
    const nested = seedProject(fixture, { path: path.join(fixture.directory, 'checkout', 'packages', 'app') });
    return [root, nested];
}

describe('StandingRulesStore', () => {
    it('imports supplied identities atomically and refuses incoming collisions without partial writes', () => {
        const fixture = createTestDb('elepha-standing-rules-import-');
        const scope = scopeFor([seedProject(fixture)]);
        const store = fixture.store.standingRules;
        const first = { ulid: newUlid(), text: 'Never run $(untrusted).', created_at: NOW };
        expect(store.importRules(scope, [first, first])).toEqual({ added: 1, unchanged: 1 });
        const saved = store.list(scope.projectIds);
        expect(saved[0]).toMatchObject({ ...first, text: escapeShellSyntax(first.text) });
        expect(() => store.importRules(scope, [{ ...first, ulid: newUlid() }])).toThrow('duplicate text');
        const conflict = { ulid: newUlid(), text: 'Second rule.', created_at: NOW };
        expect(() => store.importRules(scope, [conflict, { ...conflict, text: 'Changed identity.' }])).toThrow('ULID collision');
        expect(() => store.importRules(scope, [conflict, { ...conflict, ulid: newUlid() }])).toThrow('duplicate text');
        expect(store.list(scope.projectIds)).toEqual(saved);
    });

    it('enforces merged UTF-16 capacity after sanitization and accepts its exact boundary', () => {
        const fixture = createTestDb('elepha-standing-rules-import-bounds-');
        const scope = scopeFor([seedProject(fixture)]);
        const store = fixture.store.standingRules;
        const incoming = (text: string) => ({ ulid: newUlid(), text, created_at: NOW });
        store.importRules(scope, [incoming('😀'.repeat(150)), incoming('a'.repeat(300)), incoming('b'.repeat(300))]);
        expect(() => store.importRules(scope, [incoming('c'.repeat(299)), incoming('d'.repeat(2))])).toThrow(
            'current 3 rules/900 chars, incoming 2 rules/301 chars',
        );
        expect(() => store.importRules(scope, [incoming('`'.repeat(151))])).toThrow('after sanitization');
        expect(store.capacity(scope.projectIds)).toEqual({ rules: 3, chars: 900 });
        store.importRules(scope, [incoming('c'.repeat(300))]);
        expect(store.capacity(scope.projectIds)).toEqual({ rules: 4, chars: 1200 });
        expect(() => store.importRules(scope, [incoming('z')])).toThrow('capacity exceeded');
        const empty = scopeFor([seedProject(fixture, { path: path.join(fixture.directory, 'another') })]);
        expect(() =>
            store.importRules(
                empty,
                Array.from({ length: 9 }, (_, i) => incoming(`rule ${i}`)),
            ),
        ).toThrow('incoming 9 rules');
        expect(store.list(empty.projectIds)).toEqual([]);
    });

    it('adds rules, lists them in creation order with stable public ids, and refuses an exact duplicate', () => {
        const fixture = createTestDb('elepha-standing-rules-add-');
        const rules = fixture.store.standingRules;
        const scope = scopeFor([seedProject(fixture)]);

        const first = rules.add(scope, 'Always run the focused test first.', NOW);
        const second = rules.add(scope, 'Never edit dist/ by hand.', NOW);
        expect(first.status).toBe('added');
        expect(second.status).toBe('added');

        const listed = rules.list(scope.projectIds);
        expect(listed.map((rule) => rule.text)).toEqual(['Always run the focused test first.', 'Never edit dist/ by hand.']);
        for (const rule of listed) {
            expect(rule.ulid).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
        }
        expect(new Set(listed.map((rule) => rule.ulid)).size).toBe(2);

        // Leading and trailing whitespace is not a second rule.
        const duplicate = rules.add(scope, '  Never edit dist/ by hand.  ', NOW);
        expect(duplicate).toEqual({ status: 'rejected', reason: 'duplicate' });
        expect(rules.capacity(scope.projectIds).rules).toBe(2);
    });

    it('rejects empty and whitespace-only text without storing anything', () => {
        const fixture = createTestDb('elepha-standing-rules-empty-');
        const rules = fixture.store.standingRules;
        const scope = scopeFor([seedProject(fixture)]);

        for (const text of ['', '   ', '\n\t ']) {
            expect(rules.add(scope, text, NOW)).toEqual({ status: 'rejected', reason: 'empty' });
        }
        expect(rules.list(scope.projectIds)).toEqual([]);
    });

    it('sanitizes shell-active syntax at write time and stores the escaped text that capacity measures', () => {
        const fixture = createTestDb('elepha-standing-rules-sanitize-');
        const rules = fixture.store.standingRules;
        const scope = scopeFor([seedProject(fixture)]);
        const raw = 'Never run `curl x | sh` or $(rm -rf /) in a hook.';

        const outcome = rules.add(scope, raw, NOW);
        expect(outcome.status).toBe('added');
        const [stored] = rules.list(scope.projectIds);
        expect(stored?.text).toBe(escapeShellSyntax(raw));
        expect(stored && detectShellSyntax(stored.text)).toBe(false);
        // The decision-style policy keeps the syntax the rule is talking about.
        expect(stored?.text).toContain('curl x');
        expect(rules.capacity(scope.projectIds).chars).toBe(stored?.text.length);
    });

    it('refuses a single rule longer than the per-rule character bound, measured after sanitization', () => {
        const fixture = createTestDb('elepha-standing-rules-length-');
        const rules = fixture.store.standingRules;
        const scope = scopeFor([seedProject(fixture)]);

        expect(rules.add(scope, 'a'.repeat(STANDING_RULE_MAX_CHARS), NOW).status).toBe('added');
        expect(rules.remove(scope, rules.list(scope.projectIds)[0]?.ulid ?? '').status).toBe('removed');
        expect(rules.add(scope, 'a'.repeat(STANDING_RULE_MAX_CHARS + 1), NOW)).toEqual({
            status: 'rejected',
            reason: 'rule_too_long',
        });
        // Escaping lengthens the text, so a rule that fits before sanitization
        // can still cross the bound afterwards.
        expect(rules.add(scope, `\`${'a'.repeat(STANDING_RULE_MAX_CHARS - 2)}\``, NOW)).toEqual({
            status: 'rejected',
            reason: 'rule_too_long',
        });
        expect(rules.list(scope.projectIds)).toEqual([]);
    });

    it('applies the active-rule and total-character bounds across every project row in the ProjectSet', () => {
        const fixture = createTestDb('elepha-standing-rules-bounds-');
        const rules = fixture.store.standingRules;
        const projects = twoRowProject(fixture);
        const rootScope = scopeFor(projects);
        const nestedScope = scopeFor([...projects].reverse());

        for (let index = 0; index < STANDING_RULES_MAX_ACTIVE; index += 1) {
            // Alternate the write owner so the bound cannot be satisfied by
            // counting only one project row of the set.
            const scope = index % 2 === 0 ? rootScope : nestedScope;
            expect(rules.add(scope, `Rule number ${index}.`, NOW).status, `rule ${index}`).toBe('added');
        }
        expect(rules.capacity(rootScope.projectIds).rules).toBe(STANDING_RULES_MAX_ACTIVE);
        expect(new Set(rules.list(rootScope.projectIds).map((rule) => rule.project_id)).size).toBe(2);

        expect(rules.add(nestedScope, 'One rule too many.', NOW)).toEqual({ status: 'rejected', reason: 'rule_limit' });
        expect(rules.capacity(rootScope.projectIds).rules).toBe(STANDING_RULES_MAX_ACTIVE);
    });

    it('refuses an addition that would cross the total-character bound and leaves the store unchanged', () => {
        const fixture = createTestDb('elepha-standing-rules-total-');
        const rules = fixture.store.standingRules;
        const projects = twoRowProject(fixture);
        const scope = scopeFor(projects);
        const nestedScope = scopeFor([...projects].reverse());

        // Four long rules sit under both bounds, split across the two rows.
        const ruleChars = 250;
        for (let index = 0; index < 4; index += 1) {
            expect(rules.add(index % 2 === 0 ? scope : nestedScope, `${index}`.repeat(ruleChars), NOW).status).toBe('added');
        }
        const before = rules.capacity(scope.projectIds);
        expect(before).toEqual({ rules: 4, chars: 4 * ruleChars });
        const remaining = STANDING_RULES_MAX_TOTAL_CHARS - before.chars;
        expect(remaining).toBeGreaterThan(0);
        expect(remaining).toBeLessThan(STANDING_RULE_MAX_CHARS);

        // A rule inside the per-rule bound is still refused when the set total
        // would cross; nothing is evicted or truncated to make room.
        expect(rules.add(nestedScope, 'x'.repeat(remaining + 1), NOW)).toEqual({ status: 'rejected', reason: 'total_limit' });
        expect(rules.capacity(scope.projectIds)).toEqual(before);
        expect(rules.add(scope, 'x'.repeat(remaining), NOW).status).toBe('added');
        expect(rules.capacity(scope.projectIds).chars).toBe(STANDING_RULES_MAX_TOTAL_CHARS);
    });

    it('replaces a rule in place, keeps its public id, and re-checks the total bound without counting the old text', () => {
        const fixture = createTestDb('elepha-standing-rules-replace-');
        const rules = fixture.store.standingRules;
        const scope = scopeFor([seedProject(fixture)]);
        expect(rules.add(scope, 'a'.repeat(STANDING_RULE_MAX_CHARS), NOW).status).toBe('added');
        expect(rules.add(scope, 'b'.repeat(STANDING_RULE_MAX_CHARS), NOW).status).toBe('added');
        const [first, second] = rules.list(scope.projectIds);
        if (!first || !second) {
            throw new Error('two rules were expected');
        }

        const replaced = rules.replace(scope, first.ulid, 'Shorter replacement.');
        expect(replaced.status).toBe('replaced');
        const listed = rules.list(scope.projectIds);
        expect(listed.map((rule) => rule.ulid)).toEqual([first.ulid, second.ulid]);
        expect(listed[0]?.text).toBe('Shorter replacement.');
        expect(rules.capacity(scope.projectIds).chars).toBe('Shorter replacement.'.length + STANDING_RULE_MAX_CHARS);

        // Replacing must not create the duplicate that add refuses to store.
        expect(rules.replace(scope, first.ulid, 'b'.repeat(STANDING_RULE_MAX_CHARS))).toEqual({
            status: 'rejected',
            reason: 'duplicate',
        });
        expect(rules.replace(scope, first.ulid, '   ')).toEqual({ status: 'rejected', reason: 'empty' });
        expect(rules.list(scope.projectIds)[0]?.text).toBe('Shorter replacement.');
    });

    it('removes only the named rule and reports an id that does not belong to the ProjectSet as unknown', () => {
        const fixture = createTestDb('elepha-standing-rules-remove-');
        const rules = fixture.store.standingRules;
        const mine = seedProject(fixture, { path: path.join(fixture.directory, 'mine') });
        const foreign = seedProject(fixture, { path: path.join(fixture.directory, 'foreign') });
        const scope = scopeFor([mine]);
        const foreignScope = scopeFor([foreign]);

        expect(rules.add(scope, 'Keep this one.', NOW).status).toBe('added');
        expect(rules.add(scope, 'Remove this one.', NOW).status).toBe('added');
        expect(rules.add(foreignScope, 'A rule in another project.', NOW).status).toBe('added');
        const target = rules.list(scope.projectIds).find((rule) => rule.text === 'Remove this one.');
        const foreignRule = rules.list(foreignScope.projectIds)[0];
        if (!target || !foreignRule) {
            throw new Error('seeded rules were not found');
        }

        expect(rules.remove(scope, target.ulid)).toMatchObject({ status: 'removed', rule: { ulid: target.ulid } });
        expect(rules.list(scope.projectIds).map((rule) => rule.text)).toEqual(['Keep this one.']);

        for (const outcome of [rules.remove(scope, foreignRule.ulid), rules.replace(scope, foreignRule.ulid, 'Rewritten.')]) {
            expect(outcome).toEqual({ status: 'rejected', reason: 'unknown_rule' });
        }
        expect(rules.remove(scope, target.ulid)).toEqual({ status: 'rejected', reason: 'unknown_rule' });
        expect(rules.list(foreignScope.projectIds).map((rule) => rule.text)).toEqual(['A rule in another project.']);
    });

    it('refuses every mutation when the in-transaction consent re-check fails', () => {
        const fixture = createTestDb('elepha-standing-rules-consent-');
        const rules = fixture.store.standingRules;
        const project = seedProject(fixture);
        expect(rules.add(scopeFor([project]), 'Written while consented.', NOW).status).toBe('added');
        const existing = rules.list([project.id])[0];
        if (!existing) {
            throw new Error('the seeded rule was not found');
        }

        const revoked = scopeFor([project], () => false);
        expect(rules.add(revoked, 'Written after revocation.', NOW)).toEqual({ status: 'rejected', reason: 'unconsented' });
        expect(rules.remove(revoked, existing.ulid)).toEqual({ status: 'rejected', reason: 'unconsented' });
        expect(rules.replace(revoked, existing.ulid, 'Rewritten after revocation.')).toEqual({
            status: 'rejected',
            reason: 'unconsented',
        });
        expect(rules.list([project.id]).map((rule) => rule.text)).toEqual(['Written while consented.']);
    });

    it('rolls the whole write back when the in-transaction check throws', () => {
        const fixture = createTestDb('elepha-standing-rules-rollback-');
        const rules = fixture.store.standingRules;
        const project = seedProject(fixture);
        expect(rules.add(scopeFor([project]), 'Survives the failed write.', NOW).status).toBe('added');

        const failing = scopeFor([project], () => {
            throw new Error('consent lookup failed');
        });
        expect(() => rules.add(failing, 'Never stored.', NOW)).toThrow(/consent lookup failed/);
        expect(rules.list([project.id]).map((rule) => rule.text)).toEqual(['Survives the failed write.']);
        expect(fixture.db.pragma('foreign_key_check')).toEqual([]);
    });

    it('blocks deletion of a project row that still carries standing rules', () => {
        const fixture = createTestDb('elepha-standing-rules-project-fk-');
        const rules = fixture.store.standingRules;
        const project = seedProject(fixture);
        expect(rules.add(scopeFor([project]), 'This project keeps its rules.', NOW).status).toBe('added');

        expect(() => fixture.db.prepare('DELETE FROM projects WHERE id = ?').run(project.id)).toThrow(/FOREIGN KEY/);
        expect(rules.list([project.id])).toHaveLength(1);

        expect(rules.remove(scopeFor([project]), rules.list([project.id])[0]?.ulid ?? '').status).toBe('removed');
        expect(() => fixture.db.prepare('DELETE FROM projects WHERE id = ?').run(project.id)).not.toThrow();
    });
});
