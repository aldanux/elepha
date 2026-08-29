import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { isRefusedProjectRoot } from '../../src/config/paths.js';
import { openDb } from '../../src/storage/db.js';
import { MemoryStore } from '../../src/storage/memory-store.js';
import { withGrantableTestDir } from '../helpers/tmp.js';

const repositoryRoot = path.resolve(import.meta.dirname, '..', '..');
const tsxCli = path.join(repositoryRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const elephaCli = path.join(repositoryRoot, 'src', 'cli', 'index.ts');

function removeDirectory(directory: string): void {
    try {
        rmSync(directory, { recursive: true, force: true });
    } catch {
        // Cleanup is a courtesy; sandbox permissions must not fail the assertion.
    }
}

type ConsentCommand = 'list' | 'pending' | 'grant' | 'revoke' | 'prune';

interface RunConsentOptions {
    root?: string;
    here?: boolean;
    apply?: boolean;
    skipConfirmation?: boolean;
    cwd?: string;
}

function runConsentCli(dbPath: string, command: ConsentCommand, options: RunConsentOptions = {}) {
    const directory = path.dirname(dbPath);
    return spawnSync(
        process.execPath,
        [
            tsxCli,
            elephaCli,
            'consent',
            command,
            ...(options.root === undefined ? [] : [options.root]),
            ...(options.here ? ['--here'] : []),
            ...(options.apply ? ['--apply'] : []),
            ...(options.skipConfirmation ? ['--skip-confirmation'] : []),
        ],
        {
            cwd: options.cwd ?? repositoryRoot,
            encoding: 'utf8',
            env: {
                ...process.env,
                CLAUDE_CONFIG_DIR: path.join(directory, '.claude'),
                CODEX_HOME: path.join(directory, '.codex'),
                ELEPHA_DB_PATH: dbPath,
                ELEPHA_ENV_FILE: path.join(directory, 'missing.env'),
                ELEPHA_HOME: path.join(directory, 'elepha-home'),
            },
        },
    );
}

function runConsentPruneWithConfirmation(dbPath: string, beforeConfirmation: () => void) {
    const directory = path.dirname(dbPath);
    const forceTty = `data:text/javascript,${encodeURIComponent("Object.defineProperty(process.stdout, 'isTTY', { value: true });")}`;
    return new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
        const child = spawn(process.execPath, [tsxCli, elephaCli, 'consent', 'prune', '--apply'], {
            cwd: repositoryRoot,
            env: {
                ...process.env,
                CLAUDE_CONFIG_DIR: path.join(directory, '.claude'),
                CODEX_HOME: path.join(directory, '.codex'),
                ELEPHA_DB_PATH: dbPath,
                ELEPHA_ENV_FILE: path.join(directory, 'missing.env'),
                ELEPHA_HOME: path.join(directory, 'elepha-home'),
                NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${forceTty}`].filter(Boolean).join(' '),
            },
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        let confirmed = false;
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', (chunk: string) => {
            stdout += chunk;
            if (!confirmed && stdout.includes('[y/N] ')) {
                confirmed = true;
                beforeConfirmation();
                child.stdin.end('y\n');
            }
        });
        child.stderr.on('data', (chunk: string) => {
            stderr += chunk;
        });
        child.on('error', reject);
        child.on('close', (status) => resolve({ status, stdout, stderr }));
    });
}

function claudeTranscript(cwd: string, sessionId: string): string {
    return `${JSON.stringify({
        type: 'user',
        parentUuid: null,
        isSidechain: false,
        message: { role: 'user', content: 'Remember this request' },
        uuid: 'user-1',
        timestamp: '2026-08-25T00:00:00.000Z',
        cwd,
        sessionId,
    })}\n${JSON.stringify({
        type: 'assistant',
        parentUuid: 'user-1',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Remembered response' }] },
        uuid: 'assistant-1',
        timestamp: '2026-08-25T00:00:01.000Z',
        cwd,
        sessionId,
    })}\n`;
}

function counts(dbPath: string): { sessions: number; turns: number } {
    const db = openDb(dbPath);
    try {
        return {
            sessions: (db.prepare('SELECT COUNT(*) AS count FROM sessions').get() as { count: number }).count,
            turns: (db.prepare('SELECT COUNT(*) AS count FROM memories').get() as { count: number }).count,
        };
    } finally {
        db.close();
    }
}

describe('elepha consent grant/revoke', () => {
    it('grants the current directory and backfills its already-written transcript with --here', () => {
        const directory = mkdtempSync(path.join(tmpdir(), 'elepha-consent-grant-here-'));
        const projectDirectory = withGrantableTestDir('consent-grant-here-');
        const dbPath = path.join(directory, 'elepha.db');
        const root = path.join(projectDirectory, 'project');
        const sessionId = 'grant-here-session';
        const transcript = path.join(directory, '.claude', 'projects', 'fixture', `${sessionId}.jsonl`);
        mkdirSync(root);
        const canonicalRoot = realpathSync(root);
        mkdirSync(path.dirname(transcript), { recursive: true });
        writeFileSync(transcript, claudeTranscript(canonicalRoot, sessionId));

        try {
            const result = runConsentCli(dbPath, 'grant', { here: true, cwd: canonicalRoot });

            expect(result.status).toBe(0);
            expect(result.stdout).toContain(`Granted ${canonicalRoot}; backfilled 1 turn(s) without synthesis.`);
            const verified = openDb(dbPath);
            const store = new MemoryStore(verified);
            expect(store.consent.list()).toEqual([expect.objectContaining({ path: canonicalRoot, state: 'approved', source: 'cli' })]);
            expect(store.findSession('claude-code', sessionId)).toBeDefined();
            expect((verified.prepare('SELECT COUNT(*) AS count FROM memories').get() as { count: number }).count).toBe(1);
            verified.close();
        } finally {
            removeDirectory(directory);
            removeDirectory(projectDirectory);
        }
    }, 15000);

    it('revokes the current directory while retaining captured session and turn counts', () => {
        const directory = mkdtempSync(path.join(tmpdir(), 'elepha-consent-revoke-here-'));
        const projectDirectory = withGrantableTestDir('consent-revoke-here-');
        const dbPath = path.join(directory, 'elepha.db');
        const root = path.join(projectDirectory, 'captured-root');
        const pendingRoot = path.join(projectDirectory, 'pending-root');
        mkdirSync(root);
        const canonicalRoot = realpathSync(root);
        const db = openDb(dbPath);
        const store = new MemoryStore(db);
        store.consent.grant(canonicalRoot);
        store.consent.recordPending(pendingRoot);
        const project = store.upsertProject(canonicalRoot);
        const session = store.upsertSession('codex', 'captured-session', project.id, path.join(directory, 'captured.jsonl'));
        store.recordTurn(
            {
                tool: 'codex',
                sessionId: session.native_id,
                sourcePath: session.source_path,
                projectPath: project.path,
                turnIndex: 0,
                startedAt: '2026-08-25T00:00:00.000Z',
                endedAt: '2026-08-25T00:00:01.000Z',
                userMessage: 'Keep this memory',
                assistantText: 'This memory stays',
                toolCalls: [],
                cursor: '0',
                hasExternalContent: false,
                resumeMarkerBefore: false,
            },
            session.id,
            project.id,
            { decisions: [], pending_items: [], status: 'ok' },
        );
        db.close();
        const before = counts(dbPath);

        try {
            const result = runConsentCli(dbPath, 'revoke', { here: true, cwd: canonicalRoot });

            expect(result.status).toBe(0);
            expect(counts(dbPath)).toEqual(before);

            const pendingResult = runConsentCli(dbPath, 'revoke', { root: pendingRoot });
            expect(pendingResult.status).toBe(0);
            expect(counts(dbPath)).toEqual(before);

            const verified = openDb(dbPath);
            const verifiedStore = new MemoryStore(verified);
            expect(verifiedStore.findSession('codex', 'captured-session')).toBeDefined();
            expect(verifiedStore.consent.list()).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({ path: canonicalRoot, state: 'denied', source: 'cli' }),
                    expect.objectContaining({ path: pendingRoot, state: 'denied', source: 'cli' }),
                ]),
            );
            verified.close();
        } finally {
            removeDirectory(directory);
            removeDirectory(projectDirectory);
        }
    }, 15000);

    it.each(['grant', 'revoke'] as const)(
        'requires exactly one of path and --here for consent %s',
        (command) => {
            const directory = mkdtempSync(path.join(tmpdir(), `elepha-consent-${command}-args-`));
            const dbPath = path.join(directory, 'elepha.db');
            const root = path.join(directory, 'root');
            mkdirSync(root);

            try {
                const missing = runConsentCli(dbPath, command);
                expect(missing.status).toBe(1);
                expect(missing.stderr).toBe('Choose exactly one consent root: provide <path> or pass --here.\n');

                const duplicate = runConsentCli(dbPath, command, { root, here: true, cwd: root });
                expect(duplicate.status).toBe(1);
                expect(duplicate.stderr).toBe('Choose exactly one consent root: provide <path> or pass --here.\n');
            } finally {
                rmSync(directory, { recursive: true, force: true });
            }
        },
        15000,
    );
});

describe('elepha consent prune', () => {
    it('aborts without removing any selected root when a missing path returns before confirmation', async () => {
        const directory = mkdtempSync(path.join(tmpdir(), 'elepha-consent-prune-changed-'));
        const dbPath = path.join(directory, 'elepha.db');
        const returnedRoot = path.join(directory, 'returned-root');
        const stillMissingRoot = path.join(directory, 'still-missing-root');
        mkdirSync(returnedRoot);
        mkdirSync(stillMissingRoot);
        const canonicalReturnedRoot = realpathSync(returnedRoot);
        const canonicalStillMissingRoot = realpathSync(stillMissingRoot);
        const db = openDb(dbPath);
        const store = new MemoryStore(db);
        const selected = [store.consent.recordPending(canonicalReturnedRoot), store.consent.recordPending(canonicalStillMissingRoot)];
        db.close();
        rmSync(returnedRoot, { recursive: true });
        rmSync(stillMissingRoot, { recursive: true });

        try {
            const applied = await runConsentPruneWithConfirmation(dbPath, () => mkdirSync(returnedRoot));

            expect(applied.status).toBe(1);
            expect(applied.stdout).toContain(
                'Remove these 2 stale or refused consent root(s) from consent list? Captured memory will be kept. [y/N] ',
            );
            expect(applied.stderr).toContain(canonicalReturnedRoot);
            expect(applied.stderr).toContain('Nothing was removed.');
            expect(applied.stderr).toContain('Re-run elepha consent prune to see a fresh preview.');
            const verified = openDb(dbPath);
            expect(new Set(new MemoryStore(verified).consent.list().map((root) => root.ulid))).toEqual(
                new Set(selected.map((root) => root.ulid)),
            );
            verified.close();
        } finally {
            rmSync(directory, { recursive: true, force: true });
        }
    }, 15000);

    it('previews and removes missing and refused roots without touching live roots or memory', () => {
        const directory = mkdtempSync(path.join(tmpdir(), 'elepha-consent-prune-'));
        const dbPath = path.join(directory, 'elepha.db');
        const missingRoot = path.join(directory, 'missing-root');
        const liveRoot = realpathSync(repositoryRoot);
        const refusedParent = ['/private/tmp', '/tmp'].find(
            (candidate) => existsSync(candidate) && isRefusedProjectRoot(path.join(candidate, 'elepha-consent-prune-refused')),
        );
        expect(refusedParent).toBeDefined();
        const refusedRoot = mkdtempSync(path.join(refusedParent ?? '/tmp', 'elepha-consent-prune-refused-'));
        mkdirSync(missingRoot);

        const canonicalMissingRoot = realpathSync(missingRoot);
        const canonicalLiveRoot = realpathSync(liveRoot);
        const canonicalRefusedRoot = realpathSync(refusedRoot);
        const db = openDb(dbPath);
        const store = new MemoryStore(db);
        store.consent.recordPending(canonicalMissingRoot);
        store.consent.grant(canonicalLiveRoot);
        store.consent.revoke(canonicalRefusedRoot);
        const project = store.upsertProject(canonicalMissingRoot);
        const session = store.upsertSession('codex', 'prune-memory-session', project.id, path.join(directory, 'prune-memory.jsonl'));
        store.recordTurn(
            {
                tool: 'codex',
                sessionId: session.native_id,
                sourcePath: session.source_path,
                projectPath: project.path,
                turnIndex: 0,
                startedAt: '2026-08-28T00:00:00.000Z',
                endedAt: '2026-08-28T00:00:01.000Z',
                userMessage: 'Keep this orphaned memory',
                assistantText: 'Consent prune must not delete it',
                toolCalls: [],
                cursor: '0',
                hasExternalContent: false,
                resumeMarkerBefore: false,
            },
            session.id,
            project.id,
            { decisions: [], pending_items: [], status: 'ok' },
        );
        db.close();
        rmSync(missingRoot, { recursive: true });
        const beforeMemory = counts(dbPath);

        try {
            const preview = runConsentCli(dbPath, 'prune');

            expect(preview.status).toBe(0);
            expect(preview.stdout).toContain(`missing\t${canonicalMissingRoot}`);
            expect(preview.stdout).toContain(`refused\t${canonicalRefusedRoot}`);
            expect(preview.stdout).not.toContain(canonicalLiveRoot);
            expect(preview.stdout).toContain('nothing was deleted');
            expect(preview.stdout).toContain('Re-run with --apply');
            expect(counts(dbPath)).toEqual(beforeMemory);
            const afterPreview = openDb(dbPath);
            expect(new MemoryStore(afterPreview).consent.list()).toHaveLength(3);
            afterPreview.close();

            const applied = runConsentCli(dbPath, 'prune', { apply: true, skipConfirmation: true });

            expect(applied.status).toBe(0);
            expect(applied.stdout).toContain('Removed 2 consent root(s).');
            expect(applied.stdout).toContain('elepha purge --orphan');
            expect(counts(dbPath)).toEqual(beforeMemory);
            const verified = openDb(dbPath);
            expect(new MemoryStore(verified).consent.list()).toEqual([
                expect.objectContaining({ path: canonicalLiveRoot, state: 'approved' }),
            ]);
            verified.close();
        } finally {
            rmSync(directory, { recursive: true, force: true });
            rmSync(refusedRoot, { recursive: true, force: true });
        }
    }, 15000);
});
