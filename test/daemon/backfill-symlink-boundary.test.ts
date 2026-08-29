import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IngestionDaemon } from '../../src/daemon/index.js';
import { openDb } from '../../src/storage/db.js';
import { MemoryStore } from '../../src/storage/memory-store.js';
import type { ParsedTurn, ParseTurnsOptions, SessionAdapter } from '../../src/types/index.js';
import { withGrantableTestDir } from '../helpers/tmp.js';

class BackfillBoundaryAdapter implements SessionAdapter {
    readonly tool = 'claude-code' as const;
    readonly watchGlobs = ['*.jsonl'];
    readonly classificationCalls = new Map<string, number>();
    readonly titleCalls = new Map<string, number>();
    readonly turnParserCalls = new Map<string, number>();

    constructor(private readonly cwdBySession: Map<string, string>) {}

    matches(filePath: string): boolean {
        return path.extname(filePath) === '.jsonl';
    }

    nativeSessionId(filePath: string): string {
        return path.basename(filePath, '.jsonl');
    }

    async classifySession(filePath: string) {
        this.increment(this.classificationCalls, this.nativeSessionId(filePath));
        return { kind: 'primary' as const };
    }

    async classifyEmptySession() {
        return undefined;
    }

    async readCustomTitle(filePath: string): Promise<{ customTitle: string; scannedTo: number }> {
        const sessionId = this.nativeSessionId(filePath);
        this.increment(this.titleCalls, sessionId);
        return { customTitle: `Title for ${sessionId}`, scannedTo: 1 };
    }

    async *parseTurns(filePath: string, _sinceCursor?: string, _options?: ParseTurnsOptions): AsyncIterable<ParsedTurn> {
        const sessionId = this.nativeSessionId(filePath);
        this.increment(this.turnParserCalls, sessionId);
        const cwd = this.cwdBySession.get(sessionId);
        if (cwd === undefined) {
            throw new Error(`Missing cwd for ${sessionId}`);
        }
        yield {
            tool: this.tool,
            sessionId,
            sourcePath: filePath,
            projectPath: cwd,
            turnIndex: 0,
            startedAt: '2026-08-26T00:00:00.000Z',
            endedAt: '2026-08-26T00:01:00.000Z',
            userMessage: 'backfill this turn',
            assistantText: 'backfilled',
            toolCalls: [],
            cursor: `${sessionId}|1`,
            hasExternalContent: false,
            resumeMarkerBefore: false,
        };
    }

    private increment(calls: Map<string, number>, sessionId: string): void {
        calls.set(sessionId, (calls.get(sessionId) ?? 0) + 1);
    }
}

function createFixture(name: string): {
    fixture: string;
    watchRoot: string;
    approvedRoot: string;
    store: MemoryStore;
} {
    const fixture = realpathSync(withGrantableTestDir(`elepha-backfill-${name}-`));
    const claudeConfigDir = path.join(fixture, '.claude');
    vi.stubEnv('CLAUDE_CONFIG_DIR', claudeConfigDir);
    const watchRoot = path.join(claudeConfigDir, 'projects');
    const approvedRoot = path.join(fixture, 'approved');
    mkdirSync(watchRoot, { recursive: true });
    mkdirSync(approvedRoot);
    const canonicalApprovedRoot = realpathSync(approvedRoot);
    const store = new MemoryStore(openDb(path.join(fixture, 'elepha.db')));
    store.consent.grant(canonicalApprovedRoot);
    return { fixture, watchRoot, approvedRoot: canonicalApprovedRoot, store };
}

function writeTranscript(watchRoot: string, sessionId: string, cwd: string): string {
    const transcript = path.join(watchRoot, `${sessionId}.jsonl`);
    writeFileSync(transcript, `${JSON.stringify({ cwd })}\n`);
    return transcript;
}

function capturedRowCounts(store: MemoryStore): { projects: number; sessions: number; memories: number; cursors: number } {
    const count = (table: 'projects' | 'sessions' | 'memories'): number =>
        (store.database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
    const cursors = (store.database.prepare('SELECT COUNT(*) AS count FROM sessions WHERE cursor IS NOT NULL').get() as { count: number })
        .count;
    return { projects: count('projects'), sessions: count('sessions'), memories: count('memories'), cursors };
}

describe('approved-root backfill symlink boundary', () => {
    afterEach(() => vi.unstubAllEnvs());

    it('rejects a cwd that lexically sits inside the root but physically escapes before body parsers run', async () => {
        const { fixture, watchRoot, approvedRoot, store } = createFixture('escape');
        const outsideProject = path.join(fixture, 'outside', 'project');
        mkdirSync(outsideProject, { recursive: true });
        const escapeLink = path.join(approvedRoot, 'escape');
        symlinkSync(path.dirname(outsideProject), escapeLink, 'dir');
        const aliasedCwd = path.join(escapeLink, 'project');
        writeTranscript(watchRoot, 'escaping-session', aliasedCwd);

        const adapter = new BackfillBoundaryAdapter(new Map([['escaping-session', aliasedCwd]]));
        const daemon = new IngestionDaemon({ store, adapters: [adapter], watchRoots: [watchRoot] });

        await expect(daemon.backfillApprovedRoot(approvedRoot)).resolves.toBe(0);
        expect(adapter.classificationCalls.get('escaping-session')).toBeUndefined();
        expect(adapter.titleCalls.get('escaping-session')).toBeUndefined();
        expect(adapter.turnParserCalls.get('escaping-session')).toBeUndefined();
        expect(capturedRowCounts(store)).toEqual({ projects: 0, sessions: 0, memories: 0, cursors: 0 });
    });

    it('backfills a cwd alias that physically resolves inside the approved root', async () => {
        const { fixture, watchRoot, approvedRoot, store } = createFixture('alias-in');
        const physicalProject = path.join(approvedRoot, 'project');
        mkdirSync(physicalProject);
        const alias = path.join(fixture, 'approved-alias');
        symlinkSync(approvedRoot, alias, 'dir');
        const aliasedCwd = path.join(alias, 'project');
        writeTranscript(watchRoot, 'aliased-session', aliasedCwd);

        const adapter = new BackfillBoundaryAdapter(new Map([['aliased-session', aliasedCwd]]));
        const daemon = new IngestionDaemon({ store, adapters: [adapter], watchRoots: [watchRoot] });

        await expect(daemon.backfillApprovedRoot(approvedRoot)).resolves.toBe(1);
        expect(adapter.classificationCalls.get('aliased-session')).toBe(1);
        expect(adapter.titleCalls.get('aliased-session')).toBe(1);
        expect(adapter.turnParserCalls.get('aliased-session')).toBe(1);
        expect(capturedRowCounts(store)).toEqual({ projects: 1, sessions: 1, memories: 1, cursors: 1 });
        expect(store.listProjects().map((project) => project.path)).toEqual([aliasedCwd]);
    });

    it('backfills several approved roots in one corpus walk with the same turn count as single-root calls', async () => {
        const { fixture, watchRoot, approvedRoot, store } = createFixture('multi-root');
        const secondRoot = path.join(fixture, 'approved-two');
        const firstProject = path.join(approvedRoot, 'project-one');
        const secondProject = path.join(secondRoot, 'project-two');
        mkdirSync(firstProject);
        mkdirSync(secondProject, { recursive: true });
        const canonicalSecondRoot = realpathSync(secondRoot);
        store.consent.grant(canonicalSecondRoot);
        writeTranscript(watchRoot, 'first-root-session', firstProject);
        writeTranscript(watchRoot, 'second-root-session', secondProject);
        const cwdBySession = new Map([
            ['first-root-session', firstProject],
            ['second-root-session', secondProject],
        ]);
        const listMultiCorpus = vi.fn(async (root: string) => readdir(root, { recursive: true }));
        const multi = new IngestionDaemon({
            store,
            adapters: [new BackfillBoundaryAdapter(cwdBySession)],
            watchRoots: [watchRoot],
            readCorpus: listMultiCorpus,
        });

        const baselineStore = new MemoryStore(openDb(path.join(fixture, 'baseline.db')));
        baselineStore.consent.grant(approvedRoot);
        baselineStore.consent.grant(canonicalSecondRoot);
        const listSingleCorpus = vi.fn(async (root: string) => readdir(root, { recursive: true }));
        const singles = new IngestionDaemon({
            store: baselineStore,
            adapters: [new BackfillBoundaryAdapter(cwdBySession)],
            watchRoots: [watchRoot],
            readCorpus: listSingleCorpus,
        });

        const multiCount = await multi.backfillApprovedRoots([approvedRoot, canonicalSecondRoot]);
        const singleCount = (await singles.backfillApprovedRoot(approvedRoot)) + (await singles.backfillApprovedRoot(canonicalSecondRoot));

        expect(multiCount).toBe(singleCount);
        expect(multiCount).toBe(2);
        expect(listMultiCorpus).toHaveBeenCalledOnce();
        expect(listSingleCorpus).toHaveBeenCalledTimes(2);
        baselineStore.database.close();
    });
});
