import { describe, expect, it } from 'vitest';
import {
    type CandidateSemanticTable,
    readCandidateStandingRules,
    validateCandidateSemantics,
} from '../../src/storage/candidate-validator.js';
import { newUlid } from '../../src/storage/ulid.js';
import { createTestDb, seedConsentRoot, seedMemory, seedProject, seedRollup, seedSession } from '../helpers/db.js';

function cleanCandidate() {
    const fixture = createTestDb('elepha-candidate-validator-');
    const project = seedProject(fixture);
    const session = seedSession(fixture, { project, surface: null, kind: null, trailingFiles: ['/session.ts'] });
    seedMemory(fixture, { project, session, filesTouched: ['/memory.ts'] });
    seedRollup(fixture, { project, session, filesTouched: ['/rollup.ts'] });
    fixture.db.prepare('UPDATE session_rollups SET kind = ? WHERE session_id = ?').run('primary', session.id);
    seedConsentRoot(fixture, { path: project.path });
    return fixture;
}

describe('standing rule candidate validation', () => {
    function ruleCandidate() {
        const fixture = createTestDb('elepha-candidate-rules-');
        const project = seedProject(fixture);
        // A portable candidate is untrusted SQLite, including its constraints.
        fixture.db.exec('DROP TABLE standing_rules; CREATE TABLE standing_rules (id INTEGER, ulid, project_id INTEGER, text, created_at)');
        const ulid = newUlid();
        fixture.db
            .prepare('INSERT INTO standing_rules VALUES (?, ?, ?, ?, ?)')
            .run(1, ulid, project.id, 'A valid rule.', '2026-09-20T00:00:00.000Z');
        return { fixture, project, ulid };
    }

    it.each([
        ['id', 'wrong'],
        ['project_id', 'wrong'],
        ['project_id', 999],
        ['text', Buffer.from('text')],
        ['text', 123],
        ['text', null],
        ['text', '  '],
        ['ulid', 'not-a-ulid'],
        ['ulid', 'Z'.repeat(26)],
        ['created_at', 'not-a-date'],
        ['created_at', 123],
    ] as const)('rejects invalid %s scalar or ownership', (column, value) => {
        const { fixture } = ruleCandidate();
        fixture.db.prepare(`UPDATE standing_rules SET ${column} = ?`).run(value);
        expect(() => readCandidateStandingRules(fixture.db)).toThrow(/standing rule/i);
        expect(() => readCandidateStandingRules(fixture.db, 'restore')).toThrow(/standing rule/i);
    });

    it('rejects a present table missing canonical columns', () => {
        const { fixture } = ruleCandidate();
        fixture.db.exec('ALTER TABLE standing_rules DROP COLUMN text');
        expect(() => readCandidateStandingRules(fixture.db)).toThrow('missing required column(s): text');
    });

    it.each(['text', 'target'] as const)('rejects incoming repeated ULID with conflicting %s', (kind) => {
        const { fixture, project, ulid } = ruleCandidate();
        const second = kind === 'target' ? seedProject(fixture, { path: `${fixture.directory}-other` }) : project;
        fixture.db
            .prepare('INSERT INTO standing_rules VALUES (?, ?, ?, ?, ?)')
            .run(2, ulid, second.id, kind === 'text' ? 'Changed text.' : 'A valid rule.', '2026-09-20T00:00:00.000Z');
        expect(() => readCandidateStandingRules(fixture.db)).toThrow('ULID collision');
    });

    it('preserves identical incoming authority for the merge boundary to report unchanged', () => {
        const { fixture } = ruleCandidate();
        fixture.db.exec('INSERT INTO standing_rules SELECT 2, ulid, project_id, text, created_at FROM standing_rules');
        const rules = readCandidateStandingRules(fixture.db);
        expect(rules).toHaveLength(2);
        expect(rules[1]).toEqual({ ...rules[0], id: 2 });
        expect(() => readCandidateStandingRules(fixture.db, 'restore')).toThrow('ULID collision');
    });

    it.each(['Never execute $(download).', '  Padded rule.  '])('requires canonical persisted text for exact restore: %s', (text) => {
        const { fixture } = ruleCandidate();
        fixture.db.prepare('UPDATE standing_rules SET text = ?').run(text);
        expect(readCandidateStandingRules(fixture.db)).toHaveLength(1);
        expect(() => readCandidateStandingRules(fixture.db, 'restore')).toThrow('canonical sanitized text');
        expect(fixture.db.prepare('SELECT text FROM standing_rules').get()).toEqual({ text });
    });
});

describe('validateCandidateSemantics', () => {
    it('passes a clean candidate across every semantic table', () => {
        const fixture = cleanCandidate();

        expect(validateCandidateSemantics(fixture.db, ['sessions', 'memories', 'session_rollups', 'consent_roots'])).toEqual([]);
    });

    it.each([
        ['sessions', 'trailing_files', 'not-json'],
        ['sessions', 'trailing_files', '["valid", 1]'],
        ['memories', 'files_touched', 'not-json'],
        ['memories', 'files_touched', '{"path":"not-an-array"}'],
        ['session_rollups', 'files_touched', 'not-json'],
        ['session_rollups', 'files_touched', '[null]'],
    ] as const)('rejects malformed JSON string-array data in %s.%s', (table, column, value) => {
        const fixture = cleanCandidate();
        fixture.db.prepare(`UPDATE "${table}" SET "${column}" = ?`).run(value);

        expect(validateCandidateSemantics(fixture.db, [table])).toContain(`${table}.${column}: must be a JSON array of strings`);
    });

    it.each([
        ['sessions', 'tool', 'unknown'],
        ['sessions', 'surface', 'web'],
        ['sessions', 'kind', 'secondary'],
        ['memories', 'has_external_content', 2],
        ['session_rollups', 'kind', 'secondary'],
        ['session_rollups', 'rollup_state', 'stale'],
        ['consent_roots', 'state', 'unknown'],
        ['consent_roots', 'source', 'backup'],
    ] as const)('rejects an out-of-domain value in %s.%s', (table, column, value) => {
        const fixture = cleanCandidate();
        fixture.db.pragma('ignore_check_constraints = ON');
        fixture.db.prepare(`UPDATE "${table}" SET "${column}" = ?`).run(value);

        const violations = validateCandidateSemantics(fixture.db, [table as CandidateSemanticTable]);

        expect(violations.some((violation) => violation.startsWith(`${table}.${column}:`))).toBe(true);
    });

    it('bounds reported violations and notes when more were omitted', () => {
        const fixture = cleanCandidate();
        fixture.db.pragma('ignore_check_constraints = ON');
        fixture.db.prepare('UPDATE consent_roots SET state = ?, source = ?').run('unknown', 'backup');
        const insert = fixture.db.prepare('INSERT INTO consent_roots (ulid, path, state, decided_at, source) VALUES (?, ?, ?, ?, ?)');
        for (let index = 0; index < 10; index++) {
            insert.run(`invalid-${index}`, `/invalid/${index}`, 'unknown', '2026-08-01T00:00:00.000Z', 'backup');
        }

        const violations = validateCandidateSemantics(fixture.db, ['consent_roots']);

        expect(violations).toHaveLength(21);
        expect(violations.at(-1)).toBe('candidate: additional violations omitted after the first 20');
    });
});
