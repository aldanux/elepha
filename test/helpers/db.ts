import path from 'node:path';
import type Database from 'better-sqlite3';
import { onTestFinished } from 'vitest';
import type { ConsentRoot, ConsentState } from '../../src/storage/consent-store.js';
import { openDb } from '../../src/storage/db.js';
import { type MemoryRow, MemoryStore, type ProjectRow, type SessionRow } from '../../src/storage/memory-store.js';
import { type RollupDecision, type RollupState, RollupStore } from '../../src/storage/rollup-store.js';
import type { ParsedTurn, SessionRowKind, SessionRowSurface, SummarizationOutput, ToolName, TurnDecision } from '../../src/types/index.js';
import { withGrantableTestDir } from './tmp.js';

export interface TestDatabase {
    directory: string;
    dbPath: string;
    db: Database.Database;
    store: MemoryStore;
    close(): void;
}

// Opens a fresh on-disk database through the production schema initializer.
export function createTestDb(prefix = 'elepha-test-db-'): TestDatabase {
    const directory = withGrantableTestDir(prefix);
    const dbPath = path.join(directory, 'elepha.db');
    const db = openDb(dbPath);
    const store = new MemoryStore(db, { resolveGitRoot: () => null, resolveGitRemote: () => null });
    let closed = false;

    const close = (): void => {
        if (!closed) {
            db.close();
            closed = true;
        }
    };
    onTestFinished(close);

    return { directory, dbPath, db, store, close };
}

export interface SeedProjectOptions {
    path?: string;
}

export function seedProject(fixture: TestDatabase, options: SeedProjectOptions = {}): ProjectRow {
    return fixture.store.upsertProject(options.path ?? path.join(fixture.directory, 'project'));
}

export interface SeedSessionOptions {
    project: ProjectRow;
    tool?: ToolName;
    nativeId?: string;
    sourcePath?: string;
    surface?: SessionRowSurface | null;
    gitBranch?: string | null;
    kind?: SessionRowKind | null;
    customTitle?: string;
    title?: string | null;
    startedAt?: string;
    lastIngestedAt?: string;
    lastTurnAt?: string | null;
    gitCommitCount?: number | null;
    trailingBranch?: string | null;
    trailingFiles?: readonly string[];
}

// Seeds a session through MemoryStore. The final UPDATE covers stored metadata
// that MemoryStore intentionally derives only during live ingestion.
export function seedSession(fixture: TestDatabase, options: SeedSessionOptions): SessionRow {
    const session = fixture.store.upsertSession(
        options.tool ?? 'codex',
        options.nativeId ?? 'session-1',
        options.project.id,
        options.sourcePath ?? path.join(fixture.directory, 'session.jsonl'),
        {
            surface: options.surface,
            gitBranch: options.gitBranch,
            kind: options.kind,
            customTitle: options.customTitle,
        },
    );
    const columns: string[] = [];
    const values: unknown[] = [];
    const set = (column: string, value: unknown): void => {
        columns.push(`${column} = ?`);
        values.push(value);
    };

    if (options.title !== undefined) set('title', options.title);
    if (options.startedAt !== undefined) set('started_at', options.startedAt);
    if (options.lastIngestedAt !== undefined) set('last_ingested_at', options.lastIngestedAt);
    if (options.lastTurnAt !== undefined) set('last_turn_at', options.lastTurnAt);
    if (options.gitCommitCount !== undefined) set('git_commit_count', options.gitCommitCount);
    if (options.trailingBranch !== undefined) set('trailing_branch', options.trailingBranch);
    if (options.trailingFiles !== undefined) set('trailing_files', JSON.stringify(options.trailingFiles));
    if (columns.length > 0) {
        fixture.db.prepare(`UPDATE sessions SET ${columns.join(', ')} WHERE id = ?`).run(...values, session.id);
    }

    const seeded = fixture.store.findSession(options.tool ?? 'codex', options.nativeId ?? 'session-1');
    if (!seeded) {
        throw new Error('seeded session was not found');
    }
    return seeded;
}

export interface SeedConsentRootOptions {
    path: string;
    state?: ConsentState;
}

export function seedConsentRoot(fixture: TestDatabase, options: SeedConsentRootOptions): ConsentRoot {
    if (options.state === 'denied') return fixture.store.consent.revoke(options.path);
    if (options.state === 'pending') return fixture.store.consent.recordPending(options.path);
    return fixture.store.consent.grant(options.path);
}

export interface SeedMemoryOptions {
    session: SessionRow;
    project: ProjectRow;
    turnIndex?: number;
    startedAt?: string;
    endedAt?: string;
    userMessage?: string;
    assistantText?: string;
    cursor?: string;
    filesTouched?: readonly string[];
    decisions?: TurnDecision[];
    pendingItems?: string[];
    status?: SummarizationOutput['status'];
    hasExternalContent?: boolean;
    renderedChars?: number | null;
    renderedTurns?: number | null;
}

export function seedMemory(fixture: TestDatabase, options: SeedMemoryOptions): MemoryRow {
    const startedAt = options.startedAt ?? '2026-08-01T00:00:00.000Z';
    const turnIndex = options.turnIndex ?? 0;
    const turn: ParsedTurn = {
        tool: options.session.tool,
        sessionId: options.session.native_id,
        sourcePath: options.session.source_path,
        projectPath: options.project.path,
        turnIndex,
        startedAt,
        endedAt: options.endedAt ?? startedAt,
        userMessage: options.userMessage ?? 'user request',
        assistantText: options.assistantText ?? 'assistant response',
        toolCalls: (options.filesTouched ?? []).map((filePath) => ({ name: 'Write', filePaths: [filePath] })),
        cursor: options.cursor ?? `${turnIndex}`,
        hasExternalContent: options.hasExternalContent ?? false,
        resumeMarkerBefore: false,
    };
    const summary: SummarizationOutput = {
        decisions: options.decisions ?? [],
        pending_items: options.pendingItems ?? [],
        status: options.status ?? 'ok',
    };

    fixture.store.recordTurn(turn, options.session.id, options.project.id, summary);
    if (options.renderedChars !== undefined || options.renderedTurns !== undefined) {
        fixture.db
            .prepare(
                `UPDATE sessions
                 SET rendered_chars = COALESCE(?, rendered_chars),
                     rendered_turns = COALESCE(?, rendered_turns)
                 WHERE id = ?`,
            )
            .run(options.renderedChars ?? null, options.renderedTurns ?? null, options.session.id);
    }
    const memory = fixture.store.listMemoriesForSession(options.session.id).find((row) => row.turn_index === turnIndex);
    if (!memory) {
        throw new Error('seeded memory was not found');
    }
    return memory;
}

export interface SeedRollupOptions {
    session: SessionRow;
    project: ProjectRow;
    decisions?: RollupDecision[];
    filesTouched?: string[];
    state?: RollupState;
}

// Seeds a session-level rollup through the production persistence boundary.
export function seedRollup(fixture: TestDatabase, options: SeedRollupOptions): void {
    const rollups = new RollupStore(fixture.db);
    rollups.write(
        {
            sessionId: options.session.id,
            projectId: options.project.id,
            tool: options.session.tool,
            title: options.session.title ?? 'Seeded rollup',
            summary: '',
            decisions: options.decisions ?? [],
            pendingItems: [],
            filesTouched: options.filesTouched ?? [],
            turnCount: fixture.store.listMemoriesForSession(options.session.id).length,
            startedAt: options.session.started_at,
            endedAt: options.session.last_turn_at ?? options.session.last_ingested_at,
            kind: options.session.kind ?? 'main',
            parentSessionId: null,
            summarizerStatus: 'ok',
            state: options.state ?? 'final',
            throughTurnIndex: 1,
        },
        undefined,
    );
}
