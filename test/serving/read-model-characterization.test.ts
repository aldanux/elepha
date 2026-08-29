import { describe, expect, it } from 'vitest';
import { ElephaMcpService } from '../../src/mcp/server.js';
import { SessionReader } from '../../src/serving/session-reader.js';
import { isSubstantive, jsonArrayLength, readProjectSessions, readSessionByNaturalKey } from '../../src/storage/session-read-model.js';
import { createTestDb, seedConsentRoot, seedMemory, seedProject, seedRollup, seedSession } from '../helpers/db.js';

describe('Phase 3 read-model baseline', () => {
    it('preserves zero counts for a valid but non-array stored rollup value', () => {
        expect(jsonArrayLength('{"corrupt":"not an array"}')).toBe(0);
    });

    it('serves the identical canonical shape from the natural-key lookup and the project query (F4)', () => {
        const fixture = createTestDb('elepha-read-model-');
        const project = seedProject(fixture, { path: fixture.directory });
        const withRollup = seedSession(fixture, {
            project,
            nativeId: 'with-rollup',
            sourcePath: `${fixture.directory}/with-rollup.jsonl`,
            title: 'With rollup',
        });
        seedMemory(fixture, { project, session: withRollup, turnIndex: 0, filesTouched: ['src/a.ts'] });
        seedMemory(fixture, { project, session: withRollup, turnIndex: 1 });
        seedRollup(fixture, { project, session: withRollup, decisions: [{ what: 'ship it', why: 'tested' }] });
        const bare = seedSession(fixture, {
            project,
            nativeId: 'bare',
            sourcePath: `${fixture.directory}/bare.jsonl`,
            title: 'Bare',
        });
        seedMemory(fixture, { project, session: bare, turnIndex: 0 });

        const projectRows = readProjectSessions(fixture.db, [project.id]);
        for (const row of projectRows) {
            expect(
                readSessionByNaturalKey(fixture.db, { tool: row.tool, nativeId: row.native_id, segmentIndex: row.segment_index }),
            ).toEqual(row);
        }
        expect(readSessionByNaturalKey(fixture.db, { tool: 'codex', nativeId: 'missing', segmentIndex: 0 })).toBeUndefined();
    });

    it('uses the D50 substantive predicate for capture-only and zero-decision rollup sessions', () => {
        const fixture = createTestDb('elepha-read-model-');
        const project = seedProject(fixture, { path: fixture.directory });
        seedConsentRoot(fixture, { path: fixture.directory });

        const captureOnly = seedSession(fixture, {
            project,
            nativeId: 'capture-only',
            sourcePath: `${fixture.directory}/capture-only.jsonl`,
            title: 'Capture only',
        });
        seedMemory(fixture, { project, session: captureOnly, turnIndex: 0 });
        seedMemory(fixture, { project, session: captureOnly, turnIndex: 1 });

        const emptyRollup = seedSession(fixture, {
            project,
            nativeId: 'empty-rollup',
            sourcePath: `${fixture.directory}/empty-rollup.jsonl`,
            title: 'Empty rollup',
        });
        seedMemory(fixture, { project, session: emptyRollup, turnIndex: 0 });
        seedMemory(fixture, { project, session: emptyRollup, turnIndex: 1 });
        seedRollup(fixture, { project, session: emptyRollup });

        const projectSet = {
            key: project.path,
            displayName: project.display_name ?? 'project',
            paths: [project.path],
            projectIds: [project.id],
            gitRoot: null,
            gitRemote: null,
        };
        const readerRows = new SessionReader(fixture.db).sessionsFor(projectSet);
        const readerCaptureOnly = readerRows.find((session) => session.native_id === 'capture-only');
        const readerEmptyRollup = readerRows.find((session) => session.native_id === 'empty-rollup');

        expect(readerCaptureOnly).toBeDefined();
        expect(readerEmptyRollup).toBeDefined();
        if (readerCaptureOnly === undefined || readerEmptyRollup === undefined) {
            throw new Error('read-model fixture rows were not returned');
        }

        expect(isSubstantive(readerCaptureOnly)).toBe(true);
        expect(isSubstantive(readerEmptyRollup)).toBe(false);

        const listed = new ElephaMcpService(fixture.db).listSessions({ project: project.path, include_all: true });
        expect(listed.structuredContent).toMatchObject({
            sessions: expect.arrayContaining([
                expect.objectContaining({ title: 'Capture only', substantive: true }),
                expect.objectContaining({ title: 'Empty rollup', substantive: false }),
            ]),
        });
    });

    it('shows a two-turn capture-only session by default while hiding a trivial one-turn session', () => {
        const fixture = createTestDb('elepha-read-model-');
        const project = seedProject(fixture, { path: fixture.directory });
        seedConsentRoot(fixture, { path: fixture.directory });
        const captureOnly = seedSession(fixture, {
            project,
            nativeId: 'capture-only',
            sourcePath: `${fixture.directory}/capture-only.jsonl`,
            title: 'Capture only',
        });
        seedMemory(fixture, { project, session: captureOnly, turnIndex: 0 });
        seedMemory(fixture, { project, session: captureOnly, turnIndex: 1 });
        const trivial = seedSession(fixture, {
            project,
            nativeId: 'trivial',
            sourcePath: `${fixture.directory}/trivial.jsonl`,
            title: 'Trivial',
        });
        seedMemory(fixture, { project, session: trivial, turnIndex: 0 });

        const service = new ElephaMcpService(fixture.db);
        const defaultList = service.listSessions({ project: project.path });
        const allSessions = service.listSessions({ project: project.path, include_all: true });

        expect(defaultList.structuredContent).toMatchObject({
            sessions: [expect.objectContaining({ title: 'Capture only', substantive: true })],
        });
        expect(allSessions.structuredContent).toMatchObject({
            sessions: expect.arrayContaining([
                expect.objectContaining({ title: 'Capture only', substantive: true }),
                expect.objectContaining({ title: 'Trivial', substantive: false }),
            ]),
        });
    });
});
