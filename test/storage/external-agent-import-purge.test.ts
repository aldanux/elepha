import { copyFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CodexAdapter } from '../../src/adapters/codex.js';
import { openDb } from '../../src/storage/db.js';
import {
    applyExternalAgentImportPurge,
    planExternalAgentImportPurge,
    verifyExternalAgentImportPurge,
} from '../../src/storage/external-agent-import-purge.js';
import { MemoryStore, type SessionRow } from '../../src/storage/memory-store.js';
import { RollupStore } from '../../src/storage/rollup-store.js';
import type { ParsedTurn } from '../../src/types/index.js';

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'codex');
const IMPORTED_FIXTURE = path.join(FIXTURES, 'rollout-codex-v0.148.0-alpha.9-external-agent-import.jsonl');
const NATIVE_FIXTURE = path.join(FIXTURES, 'rollout-2026-08-10-019fa000-0000-7000-8000-000000000001-with-git.jsonl');

function turn(session: SessionRow, projectPath: string, turnIndex: number): ParsedTurn {
    return {
        tool: 'codex',
        sessionId: session.native_id,
        sourcePath: session.source_path,
        projectPath,
        turnIndex,
        startedAt: `2026-08-16T00:00:0${turnIndex}.000Z`,
        endedAt: `2026-08-16T00:00:0${turnIndex + 1}.000Z`,
        userMessage: `request ${turnIndex}`,
        assistantText: `reply ${turnIndex}`,
        toolCalls: [],
        cursor: `${turnIndex + 1}|1`,
        hasExternalContent: false,
        resumeMarkerBefore: false,
    };
}

describe('external-agent import purge', () => {
    let db: ReturnType<typeof openDb>;
    let store: MemoryStore;
    let rollups: RollupStore;
    let importedFirst: SessionRow;
    let importedSecond: SessionRow;
    let native: SessionRow;
    let importedSource: string;
    let nativeSource: string;
    const projectPath = '/Users/test/external-import-project';

    beforeEach(() => {
        const root = mkdtempSync(path.join(tmpdir(), 'elepha-external-import-purge-'));
        const codexHome = path.join(root, 'codex-home');
        const codexSessions = path.join(codexHome, 'sessions');
        mkdirSync(codexSessions, { recursive: true });
        vi.stubEnv('CODEX_HOME', codexHome);
        importedSource = path.join(codexSessions, path.basename(IMPORTED_FIXTURE));
        nativeSource = path.join(codexSessions, path.basename(NATIVE_FIXTURE));
        copyFileSync(IMPORTED_FIXTURE, importedSource);
        copyFileSync(NATIVE_FIXTURE, nativeSource);

        db = openDb(':memory:');
        store = new MemoryStore(db);
        rollups = new RollupStore(db);
        const project = store.upsertProject(projectPath);

        importedFirst = store.upsertSession('codex', 'external-native-id', project.id, importedSource);
        store.recordTurn(turn(importedFirst, projectPath, 0), importedFirst.id, project.id, {
            decisions: [],
            pending_items: [],
            status: 'ok',
        });
        importedSecond = store.startNextSegment(importedFirst, project.id, importedSource);
        store.recordTurn(turn(importedSecond, projectPath, 1), importedSecond.id, project.id, {
            decisions: [],
            pending_items: [],
            status: 'ok',
        });

        native = store.upsertSession('codex', 'native-id', project.id, nativeSource);
        store.recordTurn(turn(native, projectPath, 2), native.id, project.id, {
            decisions: [],
            pending_items: [],
            status: 'ok',
        });

        rollups.write(
            {
                sessionId: importedFirst.id,
                projectId: project.id,
                tool: 'codex',
                title: 'imported',
                summary: 'imported',
                decisions: [],
                pendingItems: [],
                filesTouched: [],
                turnCount: 1,
                startedAt: '2026-08-16T00:00:00.000Z',
                endedAt: '2026-08-16T00:00:01.000Z',
                kind: 'primary',
                parentSessionId: null,
                summarizerStatus: 'ok',
                state: 'final',
                throughTurnIndex: 0,
            },
            undefined,
        );
        rollups.write(
            {
                sessionId: native.id,
                projectId: project.id,
                tool: 'codex',
                title: 'dependent native',
                summary: 'dependent native',
                decisions: [],
                pendingItems: [],
                filesTouched: [],
                turnCount: 1,
                startedAt: '2026-08-16T00:00:02.000Z',
                endedAt: '2026-08-16T00:00:03.000Z',
                kind: 'subagent',
                parentSessionId: importedFirst.id,
                summarizerStatus: 'ok',
                state: 'final',
                throughTurnIndex: 2,
            },
            undefined,
        );
    });

    afterEach(() => vi.unstubAllEnvs());

    it('previews exact source-backed rows and resulting counts without writing', async () => {
        const plan = await planExternalAgentImportPurge(db, new CodexAdapter(() => {}));

        expect(plan.sourcePathsScanned).toBe(2);
        expect(plan.importedSourcePaths).toEqual([importedSource]);
        expect(plan.sessions.map((session) => session.id)).toEqual([importedFirst.id, importedSecond.id]);
        expect(plan.sessions.map((session) => session.memoryRows)).toEqual([1, 1]);
        expect(plan.memoryRowsAffected).toBe(2);
        expect(plan.rollupsAffected).toBe(2);
        expect(plan.emptiedProjects).toEqual([]);
        expect(plan.issues).toEqual([]);
        expect(plan.before).toEqual({ projects: 1, sessions: 3, memories: 3, rollups: 2 });
        expect(plan.resulting).toEqual({ projects: 1, sessions: 1, memories: 1, rollups: 0 });

        expect(store.findSession('codex', 'external-native-id')).toBeDefined();
        expect(store.listMemoriesForSession(importedFirst.id)).toHaveLength(1);
    });

    it('keeps a project whose only memory belongs to a session owned by another project', async () => {
        const memoryProject = store.upsertProject('/Users/test/cross-project-memory');
        const sessionProject = store.upsertProject('/Users/test/cross-project-session');
        const imported = store.upsertSession('codex', 'cross-project-import', memoryProject.id, importedSource);
        const nativeFromAnotherProject = store.upsertSession('codex', 'cross-project-native', sessionProject.id, nativeSource);
        store.recordTurn(turn(nativeFromAnotherProject, memoryProject.path, 3), nativeFromAnotherProject.id, memoryProject.id, {
            decisions: [],
            pending_items: [],
            status: 'ok',
        });

        const adapter = new CodexAdapter(() => {});
        const plan = await planExternalAgentImportPurge(db, adapter);

        expect(plan.sessions.find((session) => session.id === imported.id)?.memoryRows).toBe(0);
        expect(plan.emptiedProjects).not.toContainEqual({ id: memoryProject.id, path: memoryProject.path });

        applyExternalAgentImportPurge(db, plan);
        const verification = await verifyExternalAgentImportPurge(db, adapter, plan);

        expect(verification.ok).toBe(true);
        expect(db.prepare('SELECT id FROM projects WHERE id = ?').get(memoryProject.id)).toBeDefined();
        expect(store.listMemoriesForSession(nativeFromAnotherProject.id)).toHaveLength(1);
    });

    it('applies the preview atomically and verifies counts, foreign keys, and remaining source paths', async () => {
        const adapter = new CodexAdapter(() => {});
        const plan = await planExternalAgentImportPurge(db, adapter);

        applyExternalAgentImportPurge(db, plan);
        const verification = await verifyExternalAgentImportPurge(db, adapter, plan);

        expect(verification).toEqual({
            ok: true,
            errors: [],
            counts: { projects: 1, sessions: 1, memories: 1, rollups: 0 },
        });
        expect(store.findSession('codex', 'external-native-id')).toBeUndefined();
        expect(store.findSession('codex', 'native-id')).toBeDefined();
    });

    it('refuses a stale preview and leaves every row intact', async () => {
        const plan = await planExternalAgentImportPurge(db, new CodexAdapter(() => {}));
        store.recordTurn(turn(importedFirst, projectPath, 3), importedFirst.id, importedFirst.project_id, {
            decisions: [],
            pending_items: [],
            status: 'ok',
        });

        expect(() => applyExternalAgentImportPurge(db, plan)).toThrow('memory rows changed after preview');
        expect((db.prepare('SELECT COUNT(*) AS count FROM sessions').get() as { count: number }).count).toBe(3);
        expect((db.prepare('SELECT COUNT(*) AS count FROM memories').get() as { count: number }).count).toBe(4);
        expect((db.prepare('SELECT COUNT(*) AS count FROM session_rollups').get() as { count: number }).count).toBe(2);
    });
});
