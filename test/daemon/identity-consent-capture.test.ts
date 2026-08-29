import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IngestionDaemon } from '../../src/daemon/index.js';
import { runSessionStart } from '../../src/hooks/session-start.js';
import { openDb } from '../../src/storage/db.js';
import { MemoryStore } from '../../src/storage/memory-store.js';
import type { ParsedTurn, ParseTurnsOptions, SessionAdapter } from '../../src/types/index.js';
import { withGrantableTestDir } from '../helpers/tmp.js';

class IdentityAdapter implements SessionAdapter {
    readonly tool = 'claude-code' as const;
    readonly watchGlobs = ['*.jsonl'];
    parseCalls = 0;

    constructor(private readonly cwd: string) {}

    matches(): boolean {
        return true;
    }

    nativeSessionId(): string {
        return 'identity-consent-session';
    }

    async classifySession() {
        return { kind: 'primary' as const };
    }

    async classifyEmptySession() {
        return undefined;
    }

    async *parseTurns(filePath: string, _sinceCursor?: string, _options?: ParseTurnsOptions): AsyncIterable<ParsedTurn> {
        this.parseCalls++;
        yield turnFor(this.cwd, filePath);
    }
}

type ScanFileSeam = {
    scanFile(
        adapter: SessionAdapter,
        filePath: string,
        closeTrailingOnIdle: boolean,
    ): Promise<{ ingested: number; skipped?: { category: string } }>;
    consentStateForTurn(turn: ParsedTurn): 'approved' | 'denied' | 'pending';
};

function transcriptFor(cwd: string): { transcript: string; watchRoot: string } {
    const directory = mkdtempSync(path.join(tmpdir(), 'elepha-identity-consent-'));
    const claudeConfigDir = path.join(directory, '.claude');
    vi.stubEnv('CLAUDE_CONFIG_DIR', claudeConfigDir);
    const transcripts = path.join(claudeConfigDir, 'projects');
    const transcript = path.join(transcripts, 'session.jsonl');
    mkdirSync(transcripts, { recursive: true });
    writeFileSync(transcript, `${JSON.stringify({ cwd })}\n`);
    return { transcript, watchRoot: transcripts };
}

function turnFor(cwd: string, sourcePath: string): ParsedTurn {
    return {
        tool: 'claude-code',
        sessionId: 'identity-consent-session',
        sourcePath,
        projectPath: cwd,
        turnIndex: 0,
        startedAt: '2026-08-22T00:00:00.000Z',
        endedAt: '2026-08-22T00:01:00.000Z',
        userMessage: 'capture this checkout',
        assistantText: 'captured',
        toolCalls: [],
        cursor: '1|1',
        hasExternalContent: false,
        resumeMarkerBefore: false,
    };
}

function projectRoot(name: string): string {
    return realpathSync(withGrantableTestDir(`elepha-identity-${name}-`));
}

function identityStore(
    dbPath: string,
    roots: Record<string, string | null>,
    remotes: Record<string, string | null>,
    commits: Record<string, string | null>,
): { store: MemoryStore; gitCalls: { root: number; remote: number; commit: number } } {
    const gitCalls = { root: 0, remote: 0, commit: 0 };
    const store = new MemoryStore(openDb(dbPath), {
        resolveGitRoot: (cwd) => {
            gitCalls.root++;
            return roots[cwd] ?? null;
        },
        resolveGitRemote: (gitRoot) => {
            gitCalls.remote++;
            return remotes[gitRoot] ?? null;
        },
        resolveGitRootCommit: (gitRoot) => {
            gitCalls.commit++;
            return commits[gitRoot] ?? null;
        },
    });
    return { store, gitCalls };
}

describe('capture consent', () => {
    afterEach(() => vi.unstubAllEnvs());

    it('keeps an identity-matching checkout pending before parsing, without consulting git, and emits the pending nudge', async () => {
        const approved = projectRoot('approved');
        const moved = projectRoot('moved');
        const directory = mkdtempSync(path.join(tmpdir(), 'elepha-identity-consent-db-'));
        const dbPath = path.join(directory, 'elepha.db');
        const remote = 'git@example.test:team/repo.git';
        const commit = '1111111111111111111111111111111111111111';
        const { store, gitCalls } = identityStore(
            dbPath,
            { [approved]: approved, [moved]: moved },
            { [approved]: remote, [moved]: remote },
            { [approved]: commit, [moved]: commit },
        );
        store.upsertProject(approved);
        store.consent.grant(approved);
        Object.assign(gitCalls, { root: 0, remote: 0, commit: 0 });
        const adapter = new IdentityAdapter(moved);
        const { transcript, watchRoot } = transcriptFor(moved);
        const daemon = new IngestionDaemon({ store, adapters: [adapter], watchRoots: [watchRoot] }) as unknown as ScanFileSeam;

        expect(daemon.consentStateForTurn(turnFor(moved, transcript))).toBe('pending');
        await expect(daemon.scanFile(adapter, transcript, true)).resolves.toMatchObject({
            ingested: 0,
            skipped: { category: 'unapproved root' },
        });
        expect(adapter.parseCalls).toBe(0);
        expect(gitCalls).toEqual({ root: 0, remote: 0, commit: 0 });
        expect(store.consent.list('pending').map((root) => root.path)).toEqual([moved]);
        expect(store.listProjects().map((project) => project.path)).toEqual([approved]);

        store.database.close();
        const result = await runSessionStart(
            JSON.stringify({
                session_id: 'identity-consent-session',
                cwd: moved,
                hook_event_name: 'SessionStart',
                source: 'startup',
                model: 'gpt-5.6',
                permission_mode: 'default',
            }),
            'codex',
            {
                dbPath,
                now: () => Date.parse('2026-08-24T00:00:00.000Z'),
                readConfig: () => ({ config: { on_startup: 'notify', on_clear: 'off', on_resume: 'off', on_compact: 'off' } }),
            },
        );
        expect(result).toMatchObject({
            output: { hookSpecificOutput: { additionalContext: expect.stringContaining(`elepha consent grant ${moved}`) } },
        });
    });

    it('captures a checkout within an approved root', async () => {
        const approved = projectRoot('approved');
        const directory = mkdtempSync(path.join(tmpdir(), 'elepha-identity-consent-db-'));
        const { store } = identityStore(path.join(directory, 'elepha.db'), { [approved]: approved }, {}, {});
        store.consent.grant(approved);
        const adapter = new IdentityAdapter(approved);
        const { transcript, watchRoot } = transcriptFor(approved);
        const daemon = new IngestionDaemon({ store, adapters: [adapter], watchRoots: [watchRoot] }) as unknown as ScanFileSeam;

        expect(daemon.consentStateForTurn(turnFor(approved, transcript))).toBe('approved');
        await expect(daemon.scanFile(adapter, transcript, true)).resolves.toMatchObject({ ingested: 1 });
        expect(adapter.parseCalls).toBe(1);
        expect(store.listProjects().map((project) => project.path)).toEqual([approved]);
    });

    it('keeps a denied checkout excluded even when its identity matches an approved project', async () => {
        const approved = projectRoot('approved');
        const denied = projectRoot('denied');
        const remote = 'git@example.test:team/repo.git';
        const directory = mkdtempSync(path.join(tmpdir(), 'elepha-identity-consent-db-'));
        const { store } = identityStore(
            path.join(directory, 'elepha.db'),
            { [approved]: approved, [denied]: denied },
            { [approved]: remote, [denied]: remote },
            {},
        );
        store.upsertProject(approved);
        store.consent.grant(approved);
        store.consent.revoke(denied);
        const adapter = new IdentityAdapter(denied);
        const { transcript, watchRoot } = transcriptFor(denied);
        const daemon = new IngestionDaemon({ store, adapters: [adapter], watchRoots: [watchRoot] }) as unknown as ScanFileSeam;

        await expect(daemon.scanFile(adapter, transcript, true)).resolves.toMatchObject({ ingested: 0 });
        expect(adapter.parseCalls).toBe(0);
        expect(store.listProjects().map((project) => project.path)).toEqual([approved]);
    });
});
