import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IngestionDaemon } from '../../src/daemon/index.js';
import { openDb } from '../../src/storage/db.js';
import { MemoryStore } from '../../src/storage/memory-store.js';
import type { EmptySessionAnalysis, ParsedTurn, SessionAdapter, SessionClassification } from '../../src/types/index.js';

function turn(sourcePath: string, projectPath: string): ParsedTurn {
    return {
        tool: 'codex',
        sessionId: path.basename(sourcePath, '.jsonl'),
        sourcePath,
        projectPath,
        turnIndex: 0,
        startedAt: '2026-08-16T00:00:00.000Z',
        endedAt: '2026-08-16T00:00:01.000Z',
        userMessage: 'capture the later file',
        assistantText: 'the later file was captured',
        toolCalls: [],
        cursor: '0|1|test',
        hasExternalContent: false,
        resumeMarkerBefore: false,
    };
}

class OrderedSweepAdapter implements SessionAdapter {
    readonly tool = 'codex' as const;
    readonly watchGlobs = ['*.jsonl'];

    matches(filePath: string): boolean {
        return filePath.endsWith('.jsonl');
    }

    nativeSessionId(filePath: string): string {
        return path.basename(filePath, '.jsonl');
    }

    async classifySession(filePath: string): Promise<SessionClassification> {
        if (path.basename(filePath) === '02-throws.jsonl') {
            throw new Error('forced classifier failure');
        }
        return { kind: 'primary' };
    }

    async classifyEmptySession(filePath: string): Promise<EmptySessionAnalysis | undefined> {
        return path.basename(filePath) === '00-zero-turn.jsonl' ? { kind: 'no assistant contribution' } : undefined;
    }

    async *parseTurns(filePath: string): AsyncIterable<ParsedTurn> {
        if (path.basename(filePath) === '00-zero-turn.jsonl') {
            return;
        }
        if (path.basename(filePath) === '01-refused.jsonl') {
            yield turn(filePath, homedir());
            return;
        }
        yield turn(filePath, '/Users/test/elepha-startup-sweep-approved');
    }
}

class RoutineSkipAdapter implements SessionAdapter {
    readonly tool = 'codex' as const;
    readonly watchGlobs = ['*.jsonl'];

    matches(filePath: string): boolean {
        return filePath.endsWith('.jsonl');
    }

    nativeSessionId(filePath: string): string {
        return path.basename(filePath, '.jsonl');
    }

    async classifySession(filePath: string): Promise<SessionClassification> {
        switch (path.basename(filePath)) {
            case '00-adjudicator.jsonl':
                return { kind: 'adjudicator' };
            case '01-fork.jsonl':
                return { kind: 'fork-copy' };
            case '02-import.jsonl':
                return { kind: 'primary', exclusion: 'external-agent-import' };
            default:
                return { kind: 'primary' };
        }
    }

    async classifyEmptySession(): Promise<EmptySessionAnalysis | undefined> {
        return undefined;
    }

    async *parseTurns(): AsyncIterable<ParsedTurn> {}
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
    const started = Date.now();
    while (!predicate()) {
        if (Date.now() - started > timeoutMs) {
            throw new Error('timed out waiting for startup sweep');
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
}

describe('startup sweep containment', () => {
    let daemon: IngestionDaemon | undefined;

    afterEach(async () => {
        await daemon?.stop();
        vi.unstubAllEnvs();
    });

    it('continues past a zero-turn format alert, refused root, and unexpected throw, then summarizes every file skip', async () => {
        const root = mkdtempSync(path.join(tmpdir(), 'elepha-startup-sweep-'));
        const codexHome = path.join(root, '.codex');
        vi.stubEnv('CODEX_HOME', codexHome);
        const watchRoot = path.join(codexHome, 'sessions');
        const approvedProject = '/Users/test/elepha-startup-sweep-approved';
        mkdirSync(watchRoot, { recursive: true });

        // Lexical names pin the ordered sweep: the readable file is after all
        // contained failures and must still be ingested.
        for (const name of ['00-zero-turn.jsonl', '01-refused.jsonl', '02-throws.jsonl', '03-after.jsonl']) {
            writeFileSync(
                path.join(watchRoot, name),
                `${JSON.stringify({ cwd: name === '01-refused.jsonl' ? homedir() : approvedProject })}\n`,
            );
        }

        const logs: string[] = [];
        const store = new MemoryStore(openDb(path.join(root, 'elepha.db')));
        store.consent.grant(approvedProject);
        daemon = new IngestionDaemon({
            store,
            adapters: [new OrderedSweepAdapter()],
            watchRoots: [watchRoot],
            heartbeatPath: path.join(root, 'daemon.heartbeat.json'),
            watcherUsePolling: true,
            log: (message) => logs.push(message),
        });
        daemon.start();

        await waitFor(() => logs.some((message) => message.startsWith('[elepha] startup sweep:')));

        const project = store.findProject(approvedProject);
        expect(project).toBeDefined();
        expect(store.listRecentMemories(project!.id, 10)).toHaveLength(1);

        const refused = logs.find((message) => message.startsWith('[elepha] skipped ') && message.includes('01-refused.jsonl'));
        expect(refused).toBeUndefined();
        const zeroTurn = logs.find(
            (message) => message.includes('00-zero-turn.jsonl') && message.includes('parsed successfully but yielded zero turns'),
        );
        expect(zeroTurn).toBeUndefined();
        const thrown = logs.find(
            (message) => message.includes('02-throws.jsonl') && message.includes('unexpected error: forced classifier failure'),
        );
        expect(thrown).toBeDefined();

        const summary = logs.find((message) => message.startsWith('[elepha] startup sweep:'));
        expect(summary).toBe(
            '[elepha] startup sweep: scanned 4 file(s), ingested 1 turn(s), skipped 2 file(s) (refused root: 1; unexpected error: 1), empty sessions: 1 (no assistant contribution: 1)',
        );
    }, 15000);

    it('summarizes routine exclusions without per-file logs while retaining unreadable-file alerts', async () => {
        const root = mkdtempSync(path.join(tmpdir(), 'elepha-routine-skip-'));
        const codexHome = path.join(root, '.codex');
        vi.stubEnv('CODEX_HOME', codexHome);
        const watchRoot = path.join(codexHome, 'sessions');
        const approvedProject = '/Users/test/elepha-routine-skip-approved';
        const unapprovedProject = '/Users/test/elepha-routine-skip-unapproved';
        mkdirSync(watchRoot, { recursive: true });

        for (const name of ['00-adjudicator.jsonl', '01-fork.jsonl', '02-import.jsonl']) {
            writeFileSync(path.join(watchRoot, name), `${JSON.stringify({ cwd: approvedProject })}\n`);
        }
        writeFileSync(path.join(watchRoot, '03-unapproved.jsonl'), `${JSON.stringify({ cwd: unapprovedProject })}\n`);
        const unreadableFile = path.join(watchRoot, '04-unreadable.jsonl');
        writeFileSync(unreadableFile, 'not-json\n');

        const logs: string[] = [];
        const store = new MemoryStore(openDb(path.join(root, 'elepha.db')));
        store.consent.grant(approvedProject);
        daemon = new IngestionDaemon({
            store,
            adapters: [new RoutineSkipAdapter()],
            watchRoots: [watchRoot],
            heartbeatPath: path.join(root, 'daemon.heartbeat.json'),
            watcherUsePolling: true,
            log: (message) => logs.push(message),
        });
        daemon.start();

        await waitFor(() => logs.some((message) => message.startsWith('[elepha] startup sweep:')));

        const perFileSkipLogs = logs.filter((message) => message.startsWith('[elepha] skipped '));
        expect(perFileSkipLogs).toHaveLength(1);
        expect(perFileSkipLogs[0]).toContain(realpathSync(unreadableFile));
        expect(perFileSkipLogs[0]).toContain('not readable as plain-text JSONL');
        expect(logs).toContain(
            '[elepha] startup sweep: scanned 5 file(s), ingested 0 turn(s), skipped 5 file(s) (excluded session: 3; unapproved root: 1; unreadable content: 1)',
        );
    }, 15000);
});
