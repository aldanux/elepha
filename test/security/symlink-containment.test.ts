// chokidar's default followSymlinks:true plus matches() validating the
// symlink's own location (not its target) means a symlink placed inside a
// watched store can point at a file outside it - a private file anywhere on
// disk - and have its content read, summarized, and stored as project memory.
// resolveAbsolute() deliberately skips realpath, so nothing downstream
// re-checks containment. This is adjacent to the subprocess cwd hardening
// because both defend against attacker-controlled paths.

import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { IngestionDaemon } from '../../src/daemon/index.js';
import { openDb } from '../../src/storage/db.js';
import { MemoryStore } from '../../src/storage/memory-store.js';
import type { SummarizationInput, SummarizationOutput, SummarizationProvider } from '../../src/types/index.js';

class StubSummarizer implements SummarizationProvider {
    async summarize(_input: SummarizationInput): Promise<SummarizationOutput> {
        return { decisions: [{ what: 'stub', why: null }], pending_items: [], status: 'ok' };
    }
}

function ccTurnLines(cwd: string, sessionId: string, userText: string): string {
    const t = (offset: number) => new Date(Date.UTC(2026, 7, 1, 0, 0, offset)).toISOString();
    const user = JSON.stringify({
        type: 'user',
        parentUuid: null,
        isSidechain: false,
        message: { role: 'user', content: userText },
        uuid: 'u0',
        timestamp: t(0),
        cwd,
        sessionId,
    });
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

describe('symlink containment', () => {
    let daemon: IngestionDaemon;
    let prevConfigDir: string | undefined;
    let prevCodexHome: string | undefined;

    afterEach(async () => {
        await daemon?.stop();
        if (prevConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
        else process.env.CLAUDE_CONFIG_DIR = prevConfigDir;
        if (prevCodexHome === undefined) delete process.env.CODEX_HOME;
        else process.env.CODEX_HOME = prevCodexHome;
    });

    it('binds symlink targets to the selected provider store while preserving same-store ingestion', async () => {
        const root = mkdtempSync(path.join(tmpdir(), 'elepha-symlink-'));
        prevConfigDir = process.env.CLAUDE_CONFIG_DIR;
        prevCodexHome = process.env.CODEX_HOME;
        process.env.CLAUDE_CONFIG_DIR = path.join(root, '.claude');
        process.env.CODEX_HOME = path.join(root, '.codex');
        const claudeRoot = path.join(root, '.claude', 'projects');
        const codexRoot = path.join(root, '.codex', 'sessions');
        const projectDir = path.join(claudeRoot, 'demo-project');
        mkdirSync(projectDir, { recursive: true });
        mkdirSync(codexRoot, { recursive: true });

        // A file OUTSIDE any watched store - stands in for something private
        // elsewhere on disk (e.g. a dotfile, another app's data).
        const outsideDir = path.join(root, 'outside-the-store');
        mkdirSync(outsideDir, { recursive: true });
        const secretFile = path.join(outsideDir, 'secret.jsonl');
        writeFileSync(secretFile, ccTurnLines('/private/secret-project', 'evil', 'SECRET_TOKEN_DO_NOT_INGEST'));

        // Symlink living INSIDE the watched store, pointing at the outside file.
        const evilLink = path.join(projectDir, 'evil.jsonl');
        symlinkSync(secretFile, evilLink);

        // A cross-store target is still inside the union of watched roots, but
        // it must not inherit the Claude namespace from the link's location.
        const crossStoreCwd = '/Users/test/elepha-cross-store-project';
        const crossStoreTarget = path.join(codexRoot, 'cross-store.jsonl');
        writeFileSync(crossStoreTarget, ccTurnLines(crossStoreCwd, 'cross-store', 'CROSS_STORE_DO_NOT_INGEST'));
        const crossStoreLink = path.join(projectDir, 'cross-store.jsonl');
        symlinkSync(crossStoreTarget, crossStoreLink);

        // The same lexical shape remains valid when its physical target stays
        // inside the selected adapter's own provider store.
        const sameStoreCwd = '/Users/test/elepha-same-store-project';
        const sameStoreTarget = path.join(claudeRoot, 'same-store.transcript');
        writeFileSync(sameStoreTarget, ccTurnLines(sameStoreCwd, 'same-store', 'a same-store request'));
        const sameStoreLink = path.join(projectDir, 'same-store.jsonl');
        symlinkSync(sameStoreTarget, sameStoreLink);

        // A genuine, non-symlinked file in the same directory - proves the
        // watcher keeps working rather than going quiet on everything.
        const readableCwd = '/Users/test/elepha-symlink-demo-project';
        const readableFile = path.join(projectDir, 'readable.jsonl');
        writeFileSync(readableFile, ccTurnLines(readableCwd, 'readable', 'a real request'));

        const logs: string[] = [];
        const store = new MemoryStore(openDb(path.join(root, 'elepha.db')));
        store.consent.grant(readableCwd);
        store.consent.grant(crossStoreCwd);
        store.consent.grant(sameStoreCwd);
        store.database
            .prepare('INSERT INTO purged_transcripts (tool, native_id, purged_at) VALUES (?, ?, ?)')
            .run('codex', 'cross-store', '2026-08-01T00:00:00.000Z');
        daemon = new IngestionDaemon({
            store,
            summarizer: new StubSummarizer(),
            watchRoots: [claudeRoot, codexRoot],
            idleDebounceMs: 50,
            heartbeatPath: path.join(root, 'daemon.heartbeat.json'),
            watcherUsePolling: true,
            log: (msg) => logs.push(msg),
        });
        daemon.start();

        await waitFor(() => store.findSession('claude-code', 'readable') !== undefined);
        await waitFor(() => store.findSession('claude-code', 'same-store.transcript') !== undefined);
        // The evil file's scan races the readable one - give it a fair chance
        // to land before asserting it never does.
        await new Promise((r) => setTimeout(r, 300));

        expect(store.findSession('claude-code', 'evil')).toBeUndefined();
        expect(store.findSession('claude-code', 'cross-store')).toBeUndefined();
        expect(store.isTranscriptPurged('codex', 'cross-store')).toBe(true);
        expect(
            store.database
                .prepare(
                    'SELECT COUNT(*) AS count FROM memories JOIN sessions ON sessions.id = memories.session_id WHERE sessions.tool = ? AND sessions.native_id = ?',
                )
                .get('claude-code', 'cross-store'),
        ).toEqual({ count: 0 });
        expect(logs.some((l) => l.startsWith('[elepha] skipped ') && l.includes('evil.jsonl'))).toBe(true);
        expect(logs.some((l) => l.startsWith('[elepha] skipped ') && l.includes('cross-store.jsonl'))).toBe(true);
        expect(logs.some((l) => l.startsWith('[elepha] startup sweep:') && l.includes('outside watched store: 2'))).toBe(true);
    });
});
