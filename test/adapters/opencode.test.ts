import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3-multiple-ciphers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OpencodeAdapter, opencodeSessionAiTitle, openOpencodeDbReadonly } from '../../src/adapters/opencode.js';
import { opencodeDbPath } from '../../src/config/paths.js';
import { createOpencodeFixture } from '../fixtures/opencode-db.js';

const scratchRoot = path.resolve(import.meta.dirname, '..', '..', '.test-scratch', `opencode-${process.pid}`);
const xdgDataHome = path.join(scratchRoot, 'xdg-data');
const projectPath = path.join(scratchRoot, 'project');

beforeEach(() => {
    rmSync(scratchRoot, { recursive: true, force: true });
    mkdirSync(projectPath, { recursive: true });
    vi.stubEnv('XDG_DATA_HOME', xdgDataHome);
    createOpencodeFixture(opencodeDbPath(), projectPath);
});

afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(scratchRoot, { recursive: true, force: true });
});

describe('OpencodeAdapter', () => {
    it.each([
        ['later', '1800', '1970-01-01T00:00:01.800Z'],
        ['equal', '1100', '1970-01-01T00:00:01.100Z'],
        ['missing', undefined, '1970-01-01T00:00:01.100Z'],
        ['null', 'null', '1970-01-01T00:00:01.100Z'],
        ['string', '"1800"', '1970-01-01T00:00:01.100Z'],
        ['object', '{}', '1970-01-01T00:00:01.100Z'],
        ['nonfinite', '1e400', '1970-01-01T00:00:01.100Z'],
        ['outside the date range', '1e20', '1970-01-01T00:00:01.100Z'],
        ['earlier', '1099', '1970-01-01T00:00:01.100Z'],
    ])('uses a valid assistant completion for turn end (%s) without moving boundaries or cursors', (_label, completed, endedAt) => {
        const writable = new Database(opencodeDbPath());
        try {
            const time = completed === undefined ? '"created":1100' : `"created":1100,"completed":${completed}`;
            writable.prepare('UPDATE message SET data = ? WHERE id = ?').run(`{"role":"assistant","time":{${time}}}`, 'msg_2');
            writable
                .prepare('UPDATE message SET data = ? WHERE id = ?')
                .run(JSON.stringify({ role: 'user', time: { created: 1000, completed: 1900 } }), 'msg_1');
        } finally {
            writable.close();
        }
        const db = openOpencodeDbReadonly(opencodeDbPath());
        try {
            const adapter = new OpencodeAdapter(() => {});
            const session = adapter.dirtySessions(db).find((row) => row.sessionId === 'ses_primary')!;
            const closed = [...adapter.parseSessionTurns(db, session)];
            expect(closed).toHaveLength(1);
            expect(closed[0]).toMatchObject({
                turnIndex: 0,
                startedAt: '1970-01-01T00:00:01.000Z',
                endedAt,
                cursor: '1100|msg_2',
            });
            const resumed = [...adapter.parseSessionTurns(db, session, closed[0]?.cursor, { closeTrailingOnIdle: true })];
            expect(resumed).toHaveLength(1);
            expect(resumed[0]).toMatchObject({
                turnIndex: 1,
                startedAt: '1970-01-01T00:00:02.000Z',
                userMessage: 'Second prompt',
                assistantText: 'Second answer',
                cursor: '2100|msg_4',
            });
        } finally {
            db.close();
        }
    });

    it('treats OpenCode placeholder titles as absent', () => {
        expect(opencodeSessionAiTitle('New session - 2026-09-08T16:24:27.510Z')).toBeUndefined();
        expect(opencodeSessionAiTitle('Qué es Git')).toBe('Qué es Git');
    });

    it('enumerates dirty sessions after a strict watermark in update order', () => {
        const db = openOpencodeDbReadonly(opencodeDbPath());
        try {
            const adapter = new OpencodeAdapter();
            expect(adapter.dirtySessions(db).map((session) => session.sessionId)).toEqual(['ses_sub', 'ses_primary']);
            expect(adapter.dirtySessions(db, 100).map((session) => session.sessionId)).toEqual(['ses_primary']);
            expect(adapter.dirtySessions(db, 200)).toEqual([]);
        } finally {
            db.close();
        }
    });

    it('assembles closed turns, preserves source metadata, and reports unknown part types', () => {
        const warnings: string[] = [];
        const db = openOpencodeDbReadonly(opencodeDbPath());
        try {
            const adapter = new OpencodeAdapter((warning) => warnings.push(warning));
            const session = adapter.dirtySessions(db).find((row) => row.sessionId === 'ses_primary');
            expect(session).toBeDefined();
            const turns = [...adapter.parseSessionTurns(db, session!, undefined, { closeTrailingOnIdle: true })];

            expect(turns).toHaveLength(2);
            expect(turns[0]).toEqual({
                tool: 'opencode',
                sessionId: 'ses_primary',
                sourcePath: opencodeDbPath(),
                projectPath,
                turnIndex: 0,
                startedAt: '1970-01-01T00:00:01.000Z',
                endedAt: '1970-01-01T00:00:01.100Z',
                userMessage: 'First prompt',
                assistantText: 'First answer',
                aiTitle: 'Primary title',
                toolCalls: [{ name: 'edit', filePaths: [path.join(projectPath, 'src', 'a.ts')], text: '{"filePath":"src/a.ts"}' }],
                surface: undefined,
                gitBranch: undefined,
                hasExternalContent: false,
                resumeMarkerBefore: false,
                cursor: '1100|msg_2',
            });
            expect(turns[0]?.assistantText).not.toContain('private thought');
            expect(turns[1]).toEqual(
                expect.objectContaining({ turnIndex: 1, userMessage: 'Second prompt', assistantText: 'Second answer' }),
            );
            expect(warnings).toHaveLength(1);
            expect(warnings[0]).toContain('unrecognized part.data.type "future-part"');
        } finally {
            db.close();
        }
    });

    it('withholds the trailing turn until idle and resumes after an emitted cursor', () => {
        const db = openOpencodeDbReadonly(opencodeDbPath());
        try {
            const adapter = new OpencodeAdapter(() => {});
            const session = adapter.dirtySessions(db).find((row) => row.sessionId === 'ses_primary')!;
            const boundaryClosed = [...adapter.parseSessionTurns(db, session, undefined, { closeTrailingOnIdle: false })];
            expect(boundaryClosed.map((turn) => turn.turnIndex)).toEqual([0]);

            const resumed = [...adapter.parseSessionTurns(db, session, boundaryClosed[0]?.cursor, { closeTrailingOnIdle: true })];
            expect(resumed.map((turn) => [turn.turnIndex, turn.userMessage])).toEqual([[1, 'Second prompt']]);
        } finally {
            db.close();
        }
    });

    it('classifies parented sessions as subagents', () => {
        const db = openOpencodeDbReadonly(opencodeDbPath());
        try {
            const adapter = new OpencodeAdapter();
            const sessions = adapter.dirtySessions(db);
            expect(adapter.classifySession(sessions.find((row) => row.sessionId === 'ses_primary')!)).toEqual({ kind: 'primary' });
            expect(adapter.classifySession(sessions.find((row) => row.sessionId === 'ses_sub')!)).toEqual({
                kind: 'subagent',
                parentNativeId: 'ses_primary',
            });
        } finally {
            db.close();
        }
    });
});

describe('openOpencodeDbReadonly', () => {
    it('opens a contained fixture read-only', () => {
        const db = openOpencodeDbReadonly(opencodeDbPath());
        try {
            expect(db.readonly).toBe(true);
            expect(() => db.prepare('DELETE FROM session').run()).toThrow();
        } finally {
            db.close();
        }
    });

    it('refuses an existing database outside the OpenCode store', () => {
        const outsidePath = path.join(scratchRoot, 'outside', 'opencode.db');
        createOpencodeFixture(outsidePath, projectPath);
        expect(() => openOpencodeDbReadonly(outsidePath)).toThrow(/outside the OpenCode data store/);
    });
});
