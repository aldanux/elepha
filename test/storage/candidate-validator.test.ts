import { describe, expect, it } from 'vitest';
import { type CandidateSemanticTable, validateCandidateSemantics } from '../../src/storage/candidate-validator.js';
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
