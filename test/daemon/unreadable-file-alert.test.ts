// The file-level sibling of warnUnknownLine(): a wholly unreadable rollout
// (compressed, or just not JSON on the first line) produces zero parsed turns,
// which is indistinguishable from a genuinely idle session unless something
// says so out loud. IngestionDaemon.assertReadableJsonl makes this failure
// distinguishable from an idle session.

import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClaudeCodeAdapter } from '../../src/adapters/claude-code.js';
import { CodexAdapter } from '../../src/adapters/codex.js';
import { IngestionDaemon } from '../../src/daemon/index.js';
import { ReadabilityGuard } from '../../src/daemon/readability-guard.js';
import { openDb } from '../../src/storage/db.js';
import { MemoryStore } from '../../src/storage/memory-store.js';
import type { SummarizationInput, SummarizationOutput, SummarizationProvider } from '../../src/types/index.js';

class StubSummarizer implements SummarizationProvider {
    async summarize(_input: SummarizationInput): Promise<SummarizationOutput> {
        return { decisions: [{ what: 'stub', why: null }], pending_items: [], status: 'ok' };
    }
}

function ccTurnLines(cwd: string, sessionId: string): string {
    const t = (offset: number) => new Date(Date.UTC(2026, 7, 1, 0, 0, offset)).toISOString();
    const user = JSON.stringify({
        type: 'user',
        parentUuid: null,
        isSidechain: false,
        message: { role: 'user', content: 'a real request' },
        uuid: 'u0',
        timestamp: t(0),
        cwd,
        sessionId,
    });
    // A turn only counts as provably closed once the assistant reply lands -
    // without this, the daemon has nothing to wait for and the turn never ingests.
    const assistant = JSON.stringify({
        type: 'assistant',
        parentUuid: 'u0',
        message: { role: 'assistant', content: [{ type: 'text', text: 'a real reply' }] },
        uuid: 'a0',
        timestamp: t(1),
        cwd,
        sessionId,
    });
    return `${user}\n${assistant}\n`;
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
    const start = Date.now();
    while (!predicate()) {
        if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for condition');
        await new Promise((r) => setTimeout(r, 20));
    }
}

describe('file-level unreadable-file alert', () => {
    let daemon: IngestionDaemon;
    let prevConfigDir: string | undefined;
    let prevCodexHome: string | undefined;

    afterEach(async () => {
        await daemon?.stop();
        if (prevConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
        else process.env.CLAUDE_CONFIG_DIR = prevConfigDir;
        if (prevCodexHome === undefined) delete process.env.CODEX_HOME;
        else process.env.CODEX_HOME = prevCodexHome;
        vi.restoreAllMocks();
    });

    it('checks content written after the file was first seen empty', async () => {
        const root = mkdtempSync(path.join(tmpdir(), 'elepha-unreadable-empty-first-'));
        const transcript = path.join(root, 'session.jsonl');
        writeFileSync(transcript, '');
        const guard = new ReadabilityGuard();

        await expect(guard.assertReadableJsonl(transcript)).resolves.toBeUndefined();

        writeFileSync(transcript, 'not json\n');
        await expect(guard.assertReadableJsonl(transcript)).resolves.toMatchObject({
            category: 'unreadable content',
            reason: expect.stringContaining('first line is not valid JSON'),
        });
    });

    it('replaces skip reasons under one canonical key and clears the entry after a successful scan', async () => {
        const root = mkdtempSync(path.join(tmpdir(), 'elepha-skip-lifecycle-'));
        const claudeConfigDir = path.join(root, '.claude');
        const projectsRoot = path.join(claudeConfigDir, 'projects');
        const projectDir = path.join(projectsRoot, 'real-project');
        const aliasDir = path.join(projectsRoot, 'alias-project');
        const transcript = path.join(projectDir, 'session.jsonl');
        const alias = path.join(aliasDir, 'session.jsonl');
        const cwd = '/Users/test/elepha-skip-lifecycle-project';
        mkdirSync(projectDir, { recursive: true });
        writeFileSync(transcript, ccTurnLines(cwd, 'session'));
        symlinkSync(projectDir, aliasDir);
        prevConfigDir = process.env.CLAUDE_CONFIG_DIR;
        process.env.CLAUDE_CONFIG_DIR = claudeConfigDir;

        const store = new MemoryStore(openDb(path.join(root, 'elepha.db')));
        store.consent.grant(cwd);
        const adapter = new ClaudeCodeAdapter();
        vi.spyOn(adapter, 'classifySession')
            .mockRejectedValueOnce(new Error('forced classifier failure'))
            .mockResolvedValueOnce({ kind: 'primary', exclusion: 'external-agent-import' });
        daemon = new IngestionDaemon({
            store,
            adapters: [adapter],
            watchRoots: [projectsRoot],
            heartbeatPath: path.join(root, 'daemon.heartbeat.json'),
        });
        const scan = daemon as unknown as {
            scanFile(
                adapter: ClaudeCodeAdapter,
                filePath: string,
                closeTrailingOnIdle: boolean,
            ): Promise<{ ingested: number; skipped?: { category: string; reason: string } }>;
            skippedFiles: Map<string, { category: string; reason: string }>;
        };

        await expect(scan.scanFile(adapter, alias, true)).resolves.toMatchObject({
            skipped: { category: 'unexpected error' },
        });
        await expect(scan.scanFile(adapter, transcript, true)).resolves.toMatchObject({
            skipped: { category: 'excluded session' },
        });
        expect([...scan.skippedFiles.entries()]).toEqual([
            [realpathSync(transcript), expect.objectContaining({ category: 'excluded session' })],
        ]);

        await expect(scan.scanFile(adapter, alias, true)).resolves.toMatchObject({ ingested: 1 });
        expect(scan.skippedFiles.size).toBe(0);
    });

    it('warns once per file for a compressed rollout, stays silent for a readable one, and does not stop the watcher', async () => {
        const root = mkdtempSync(path.join(tmpdir(), 'elepha-unreadable-'));
        prevConfigDir = process.env.CLAUDE_CONFIG_DIR;
        process.env.CLAUDE_CONFIG_DIR = path.join(root, '.claude');
        const projectDir = path.join(root, '.claude', 'projects', 'demo-project');
        mkdirSync(projectDir, { recursive: true });
        const cwd = '/Users/test/elepha-unreadable-demo-project';

        // zstd magic bytes (0x28 0xB5 0x2F 0xFD) followed by junk - what a
        // compressed Codex rollout would look like to the daemon.
        const compressedFile = path.join(projectDir, 'compressed.jsonl');
        writeFileSync(compressedFile, Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x01, 0x02, 0x03, 0x04, 0x0a, 0x05, 0x06]));

        // Not compressed, but the first line isn't JSON either - a rotated or
        // truncated file, or a format warnUnknownLine() has never seen.
        const garbageFile = path.join(projectDir, 'garbage.jsonl');
        writeFileSync(garbageFile, 'this is not json at all\nneither is this\n');

        const readableFile = path.join(projectDir, 'readable.jsonl');
        writeFileSync(readableFile, ccTurnLines(cwd, 'sess-readable'));

        const logs: string[] = [];
        const store = new MemoryStore(openDb(path.join(root, 'elepha.db')));
        store.consent.grant(cwd);
        daemon = new IngestionDaemon({
            store,
            summarizer: new StubSummarizer(),
            idleDebounceMs: 100,
            watchRoots: [path.join(root, '.claude', 'projects')],
            heartbeatPath: path.join(root, 'daemon.heartbeat.json'),
            watcherUsePolling: true,
            log: (msg) => logs.push(msg),
        });
        daemon.start();

        // The readable file proves the watcher survives the two unreadable
        // files alongside it - a file-level failure must not take down ingestion
        // of everything else, only be loud about the file that failed.
        await waitFor(() => store.findProject(cwd) !== undefined && store.listRecentMemories(store.findProject(cwd)!.id, 10).length === 1);

        const compressedWarning = logs.find((l) => l.includes('compressed.jsonl') && l.includes('not readable as plain-text JSONL'));
        expect(compressedWarning).toBeDefined();
        expect(compressedWarning).toContain('looks compressed');

        const garbageWarning = logs.find((l) => l.includes('garbage.jsonl') && l.includes('not readable as plain-text JSONL'));
        expect(garbageWarning).toBeDefined();
        expect(garbageWarning).not.toContain('looks compressed');

        expect(logs.filter((l) => l.includes('readable.jsonl') && l.includes('not readable as plain-text JSONL'))).toHaveLength(0);

        // Exactly the one real turn made it into memory - the two unreadable
        // files produced zero rows, not phantom empty-but-valid-looking ones.
        expect(store.listRecentMemories(store.findProject(cwd)!.id, 10)).toHaveLength(1);
    }, 15000);

    it('audibly skips a .zst Codex rollout at the readability guard without parsing it', async () => {
        const root = mkdtempSync(path.join(tmpdir(), 'elepha-unreadable-codex-zst-'));
        const codexHome = path.join(root, '.codex');
        const sessionsRoot = path.join(codexHome, 'sessions');
        const rollout = path.join(
            sessionsRoot,
            '2026',
            '08',
            '22',
            'rollout-2026-08-22T09-00-00-019fc000-0000-7000-8000-000000000152.jsonl.zst',
        );
        mkdirSync(path.dirname(rollout), { recursive: true });
        // Fixture bytes only: the readability guard must identify zstd before
        // any JSONL parser sees the file.
        writeFileSync(rollout, Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x01, 0x02, 0x03, 0x04]));
        prevCodexHome = process.env.CODEX_HOME;
        process.env.CODEX_HOME = codexHome;

        const parseTurns = vi.spyOn(CodexAdapter.prototype, 'parseTurns');
        const logs: string[] = [];
        const store = new MemoryStore(openDb(path.join(root, 'elepha.db')));
        daemon = new IngestionDaemon({
            store,
            watchRoots: [sessionsRoot],
            heartbeatPath: path.join(root, 'daemon.heartbeat.json'),
            watcherUsePolling: true,
            log: (message) => logs.push(message),
        });
        daemon.start();

        await waitFor(() => logs.some((message) => message.startsWith('[elepha] startup sweep:')));

        const skip = logs.find((message) => message.startsWith('[elepha] skipped ') && message.includes(path.basename(rollout)));
        expect(skip).toContain('not readable as plain-text JSONL');
        expect(skip).toContain('looks compressed');
        expect(logs).toContain('[elepha] startup sweep: scanned 1 file(s), ingested 0 turn(s), skipped 1 file(s) (unreadable content: 1)');
        expect(parseTurns).not.toHaveBeenCalled();
    }, 15000);
});
