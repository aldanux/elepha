import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IngestionDaemon } from '../../src/daemon/index.js';
import { runUserPromptSubmit } from '../../src/hooks/user-prompt-submit.js';
import { openDb } from '../../src/storage/db.js';
import { MemoryStore } from '../../src/storage/memory-store.js';
import type {
    ParsedTurn,
    ParseTurnsOptions,
    SessionAdapter,
    SummarizationInput,
    SummarizationOutput,
    SummarizationProvider,
} from '../../src/types/index.js';
import { withGrantableTestDir } from '../helpers/tmp.js';

const DENIED_SESSION = 'denied-off-era-session';
const PENDING_SESSION = 'pending-history-session';
const MID_DENIED_SESSION = 'mid-transcript-denied-session';
const REVOKED_DURING_SUMMARY_SESSION = 'revoked-during-summary-session';

class IncognitoAdapter implements SessionAdapter {
    readonly tool = 'claude-code' as const;
    readonly watchGlobs = ['*.jsonl'];
    readonly parseCalls = new Map<string, number>();
    readonly yieldedTurns = new Map<string, number>();

    constructor(private readonly projectBySession: ReadonlyMap<string, string | readonly string[]>) {}

    matches(filePath: string): boolean {
        return filePath.endsWith('.jsonl');
    }

    nativeSessionId(filePath: string): string {
        return path.basename(filePath, '.jsonl');
    }

    async classifySession() {
        return { kind: 'primary' as const };
    }

    async classifyEmptySession() {
        return undefined;
    }

    async *parseTurns(filePath: string, _sinceCursor?: string, _options?: ParseTurnsOptions): AsyncIterable<ParsedTurn> {
        const sessionId = this.nativeSessionId(filePath);
        this.parseCalls.set(sessionId, (this.parseCalls.get(sessionId) ?? 0) + 1);
        const configuredPaths = this.projectBySession.get(sessionId);
        if (!configuredPaths) {
            throw new Error(`missing project fixture for ${sessionId}`);
        }
        const projectPaths = typeof configuredPaths === 'string' ? [configuredPaths] : configuredPaths;
        for (const [turnIndex, projectPath] of projectPaths.entries()) {
            this.yieldedTurns.set(sessionId, (this.yieldedTurns.get(sessionId) ?? 0) + 1);
            yield {
                tool: this.tool,
                sessionId,
                sourcePath: filePath,
                projectPath,
                turnIndex,
                startedAt: `2026-08-${String(25 + turnIndex).padStart(2, '0')}T00:00:00.000Z`,
                endedAt: `2026-08-${String(25 + turnIndex).padStart(2, '0')}T00:01:00.000Z`,
                userMessage:
                    sessionId === DENIED_SESSION
                        ? 'Denied off-era session'
                        : sessionId === PENDING_SESSION
                          ? 'Pending history session'
                          : `Turn ${turnIndex}`,
                assistantText: 'captured reply',
                toolCalls: [],
                cursor: `${sessionId}|${turnIndex + 1}`,
                hasExternalContent: false,
                resumeMarkerBefore: false,
            };
        }
    }
}

class PausingSummarizer implements SummarizationProvider {
    readonly started: Promise<void>;
    private markStarted!: () => void;
    private readonly resumed: Promise<void>;
    private resume!: () => void;

    constructor() {
        this.started = new Promise((resolve) => {
            this.markStarted = resolve;
        });
        this.resumed = new Promise((resolve) => {
            this.resume = resolve;
        });
    }

    async summarize(_input: SummarizationInput): Promise<SummarizationOutput> {
        this.markStarted();
        await this.resumed;
        return { decisions: [], pending_items: [], status: 'ok' };
    }

    continue(): void {
        this.resume();
    }
}

type ScanFileSeam = {
    backfillApprovedRoot(root: string): Promise<number>;
    scanFile(
        adapter: SessionAdapter,
        filePath: string,
        closeTrailingOnIdle: boolean,
        onlyProjectRoot?: string,
    ): Promise<{ ingested: number; skipped?: { category: string } }>;
};

function listPayload(cwd: string): string {
    return JSON.stringify({
        session_id: 'current-session',
        cwd,
        hook_event_name: 'UserPromptSubmit',
        prompt: 'elepha:list',
        turn_id: 'turn-1',
        model: 'gpt-5.6',
        permission_mode: 'default',
        transcript_path: null,
    });
}

describe('capture-off incognito tombstones', () => {
    afterEach(() => vi.unstubAllEnvs());

    it('permanently vetoes denied sessions while a first grant still backfills pending history', async () => {
        const fixture = withGrantableTestDir('elepha-incognito-');
        const claudeConfigDir = path.join(fixture, '.claude');
        vi.stubEnv('CLAUDE_CONFIG_DIR', claudeConfigDir);
        const watchRoot = path.join(claudeConfigDir, 'projects');
        const deniedRoot = path.join(fixture, 'denied-project');
        const pendingRoot = path.join(fixture, 'pending-project');
        mkdirSync(watchRoot, { recursive: true });
        mkdirSync(deniedRoot);
        mkdirSync(pendingRoot);
        const canonicalDeniedRoot = realpathSync(deniedRoot);
        const canonicalPendingRoot = realpathSync(pendingRoot);
        const deniedTranscript = path.join(watchRoot, `${DENIED_SESSION}.jsonl`);
        const pendingTranscript = path.join(watchRoot, `${PENDING_SESSION}.jsonl`);
        writeFileSync(deniedTranscript, `${JSON.stringify({ cwd: canonicalDeniedRoot })}\n`);
        writeFileSync(pendingTranscript, `${JSON.stringify({ cwd: canonicalPendingRoot })}\n`);

        const dbPath = path.join(fixture, 'elepha.db');
        const store = new MemoryStore(openDb(dbPath), {
            resolveGitRoot: () => null,
            resolveGitRemote: () => null,
            resolveGitRootCommit: () => null,
        });
        store.consent.revoke(canonicalDeniedRoot);
        const adapter = new IncognitoAdapter(
            new Map([
                [DENIED_SESSION, canonicalDeniedRoot],
                [PENDING_SESSION, canonicalPendingRoot],
            ]),
        );
        const daemon = new IngestionDaemon({ store, adapters: [adapter], watchRoots: [watchRoot] }) as unknown as ScanFileSeam;

        await expect(daemon.scanFile(adapter, deniedTranscript, true)).resolves.toMatchObject({ ingested: 0 });
        await expect(daemon.scanFile(adapter, pendingTranscript, true)).resolves.toMatchObject({ ingested: 0 });
        expect(adapter.parseCalls.size).toBe(0);
        expect(store.isTranscriptIncognito('claude-code', DENIED_SESSION)).toBe(true);
        expect(store.isTranscriptIncognito('claude-code', PENDING_SESSION)).toBe(false);

        store.consent.grant(canonicalDeniedRoot);
        store.consent.grant(canonicalPendingRoot);
        expect(await daemon.backfillApprovedRoot(canonicalDeniedRoot)).toBe(0);
        expect(await daemon.backfillApprovedRoot(canonicalPendingRoot)).toBe(1);
        expect(adapter.parseCalls.get(DENIED_SESSION)).toBeUndefined();
        expect(adapter.parseCalls.get(PENDING_SESSION)).toBe(1);
        expect(store.findSession('claude-code', DENIED_SESSION)).toBeUndefined();
        expect(store.findSession('claude-code', PENDING_SESSION)).toBeDefined();

        const list = await runUserPromptSubmit(listPayload(canonicalPendingRoot), 'claude-code', {
            dbPath,
            now: () => Date.parse('2026-08-26T01:00:00.000Z'),
        });
        expect('output' in list, JSON.stringify(list)).toBe(true);
        if ('output' in list) {
            const context = (list.output.hookSpecificOutput as Record<string, string>).additionalContext;
            expect(context).toContain('Pending history session');
            expect(context).not.toContain('Denied off-era session');
        }

        await expect(daemon.scanFile(adapter, deniedTranscript, true)).resolves.toMatchObject({ ingested: 0 });
        expect(adapter.parseCalls.get(DENIED_SESSION)).toBeUndefined();
        expect(store.findSession('claude-code', DENIED_SESSION)).toBeUndefined();
        expect(store.database.prepare('SELECT COUNT(*) AS count FROM memories').get()).toEqual({ count: 1 });
    });

    it('tombstones a session at a later denied cwd and never advances or ingests it again', async () => {
        const fixture = withGrantableTestDir('elepha-mid-transcript-denied-');
        const claudeConfigDir = path.join(fixture, '.claude');
        vi.stubEnv('CLAUDE_CONFIG_DIR', claudeConfigDir);
        const watchRoot = path.join(claudeConfigDir, 'projects');
        const approvedRoot = path.join(fixture, 'approved-project');
        const deniedRoot = path.join(fixture, 'denied-project');
        mkdirSync(watchRoot, { recursive: true });
        mkdirSync(approvedRoot);
        mkdirSync(deniedRoot);
        const canonicalApprovedRoot = realpathSync(approvedRoot);
        const canonicalDeniedRoot = realpathSync(deniedRoot);
        const transcript = path.join(watchRoot, `${MID_DENIED_SESSION}.jsonl`);
        writeFileSync(transcript, `${JSON.stringify({ cwd: canonicalApprovedRoot })}\n`);

        const store = new MemoryStore(openDb(path.join(fixture, 'elepha.db')));
        store.consent.grant(canonicalApprovedRoot);
        store.consent.revoke(canonicalDeniedRoot);
        const adapter = new IncognitoAdapter(
            new Map([[MID_DENIED_SESSION, [canonicalApprovedRoot, canonicalDeniedRoot, canonicalApprovedRoot]]]),
        );
        const daemon = new IngestionDaemon({ store, adapters: [adapter], watchRoots: [watchRoot] }) as unknown as ScanFileSeam;

        await expect(daemon.scanFile(adapter, transcript, true)).resolves.toMatchObject({ ingested: 1 });
        expect(store.isTranscriptIncognito('claude-code', MID_DENIED_SESSION)).toBe(true);
        expect(store.getSessionCursor('claude-code', MID_DENIED_SESSION)).toBe(`${MID_DENIED_SESSION}|1`);
        expect(adapter.yieldedTurns.get(MID_DENIED_SESSION)).toBe(2);
        expect(store.database.prepare('SELECT COUNT(*) AS count FROM memories').get()).toEqual({ count: 1 });

        store.consent.grant(canonicalDeniedRoot);
        expect(await daemon.backfillApprovedRoot(canonicalApprovedRoot)).toBe(0);
        await expect(daemon.scanFile(adapter, transcript, true)).resolves.toMatchObject({ ingested: 0 });
        expect(adapter.parseCalls.get(MID_DENIED_SESSION)).toBe(1);
        expect(adapter.yieldedTurns.get(MID_DENIED_SESSION)).toBe(2);
        expect(store.getSessionCursor('claude-code', MID_DENIED_SESSION)).toBe(`${MID_DENIED_SESSION}|1`);
        expect(store.database.prepare('SELECT COUNT(*) AS count FROM memories').get()).toEqual({ count: 1 });
    });

    it('tombstones a turn revoked from a second connection during summarization and permanently excludes it', async () => {
        const fixture = withGrantableTestDir('elepha-revoke-during-summary-');
        const claudeConfigDir = path.join(fixture, '.claude');
        vi.stubEnv('CLAUDE_CONFIG_DIR', claudeConfigDir);
        const watchRoot = path.join(claudeConfigDir, 'projects');
        const projectRoot = path.join(fixture, 'project');
        mkdirSync(watchRoot, { recursive: true });
        mkdirSync(projectRoot);
        const canonicalProjectRoot = realpathSync(projectRoot);
        const transcript = path.join(watchRoot, `${REVOKED_DURING_SUMMARY_SESSION}.jsonl`);
        writeFileSync(transcript, `${JSON.stringify({ cwd: canonicalProjectRoot })}\n`);

        const dbPath = path.join(fixture, 'elepha.db');
        const store = new MemoryStore(openDb(dbPath));
        store.consent.grant(canonicalProjectRoot);
        const adapter = new IncognitoAdapter(new Map([[REVOKED_DURING_SUMMARY_SESSION, canonicalProjectRoot]]));
        const summarizer = new PausingSummarizer();
        const daemon = new IngestionDaemon({ store, summarizer, adapters: [adapter], watchRoots: [watchRoot] }) as unknown as ScanFileSeam;

        const scan = daemon.scanFile(adapter, transcript, true);
        await summarizer.started;
        const revokingStore = new MemoryStore(openDb(dbPath));
        revokingStore.consent.revoke(canonicalProjectRoot);
        revokingStore.database.close();
        summarizer.continue();

        await expect(scan).resolves.toMatchObject({ ingested: 0 });
        expect(store.isTranscriptIncognito('claude-code', REVOKED_DURING_SUMMARY_SESSION)).toBe(true);
        expect(store.listProjects()).toEqual([]);
        expect(store.database.prepare('SELECT COUNT(*) AS count FROM sessions').get()).toEqual({ count: 0 });
        expect(store.database.prepare('SELECT COUNT(*) AS count FROM memories').get()).toEqual({ count: 0 });

        store.consent.grant(canonicalProjectRoot);
        expect(await daemon.backfillApprovedRoot(canonicalProjectRoot)).toBe(0);
        await expect(daemon.scanFile(adapter, transcript, true)).resolves.toMatchObject({ ingested: 0 });
        expect(adapter.parseCalls.get(REVOKED_DURING_SUMMARY_SESSION)).toBe(1);
        expect(store.listProjects()).toEqual([]);
        expect(store.database.prepare('SELECT COUNT(*) AS count FROM sessions').get()).toEqual({ count: 0 });
        expect(store.database.prepare('SELECT COUNT(*) AS count FROM memories').get()).toEqual({ count: 0 });
    });
});
