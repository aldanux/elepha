import { describe, expect, it, vi } from 'vitest';
import { isSubstantive, readProjectSessions, readSessionById } from '../../src/storage/session-read-model.js';
import { createTestDb, seedProject, seedRollup, seedSession } from '../helpers/db.js';

describe('session read model', () => {
    it('exposes instructions through both readers and treats an instruction-only rollup as substantive', () => {
        const fixture = createTestDb('elepha-instruction-read-');
        const project = seedProject(fixture, { path: fixture.directory });
        const session = seedSession(fixture, { project });
        seedRollup(fixture, { project, session, instructions: [{ what: 'Always run tests' }] });
        const direct = readSessionById(fixture.db, session.id)!;
        expect(JSON.parse(direct.rollup_instructions!)).toEqual([{ what: 'Always run tests' }]);
        expect(readProjectSessions(fixture.db, [project.id])[0].rollup_instructions).toBe(direct.rollup_instructions);
        expect(isSubstantive(direct)).toBe(true);
    });

    it('degrades malformed trailing files without breaking project reads and warns once per session', () => {
        const fixture = createTestDb('elepha-read-model-');
        const project = seedProject(fixture, { path: fixture.directory });
        const malformed = seedSession(fixture, {
            project,
            nativeId: 'malformed-trailing-files',
            trailingFiles: ['replaced below'],
        });
        const wrongShape = seedSession(fixture, {
            project,
            nativeId: 'wrong-shape-trailing-files',
            trailingFiles: ['replaced below'],
        });
        const valid = seedSession(fixture, {
            project,
            nativeId: 'valid-trailing-files',
            trailingFiles: ['a', 'b'],
        });
        fixture.db.prepare('UPDATE sessions SET trailing_files = ? WHERE id = ?').run('not-json', malformed.id);
        fixture.db.prepare('UPDATE sessions SET trailing_files = ? WHERE id = ?').run('{"a":1}', wrongShape.id);
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

        const listed = readProjectSessions(fixture.db, [project.id]);

        expect(listed.find((session) => session.id === malformed.id)?.trailing_files).toEqual([]);
        expect(listed.find((session) => session.id === wrongShape.id)?.trailing_files).toEqual([]);
        expect(listed.find((session) => session.id === valid.id)?.trailing_files).toEqual(['a', 'b']);
        expect(() => readProjectSessions(fixture.db, [project.id])).not.toThrow();
        expect(readSessionById(fixture.db, malformed.id)?.trailing_files).toEqual([]);
        expect(readSessionById(fixture.db, wrongShape.id)?.trailing_files).toEqual([]);
        expect(warn).toHaveBeenCalledTimes(2);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining(`session ${malformed.id} trailing_files`));
        expect(warn).toHaveBeenCalledWith(expect.stringContaining(`session ${wrongShape.id} trailing_files`));
    });
});
