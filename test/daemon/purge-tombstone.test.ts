import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { IngestionDaemon } from '../../src/daemon/index.js';
import { runUserPromptSubmit } from '../../src/hooks/user-prompt-submit.js';
import { ElephaMcpService, openMcpReadOnlyDatabase } from '../../src/mcp/server.js';
import { openDb } from '../../src/storage/db.js';
import { MemoryStore } from '../../src/storage/memory-store.js';
import type { ParsedTurn } from '../../src/types/index.js';

const SOURCE_FIXTURE = path.join(
    __dirname,
    '..',
    'fixtures',
    'codex',
    'rollout-2026-08-11T16-42-22-019ff033-9dec-7f73-ba44-b76ac18116de-response-item-only.jsonl',
);
// The fixture has a suffix after the UUID, so production falls back to its
// complete basename. Pin the tombstone to that actual adapter identity.
const NATIVE_ID = path.basename(SOURCE_FIXTURE, '.jsonl');

function text(response: { content: Array<{ type: string; text?: string }> }): string {
    return response.content.find((block) => block.type === 'text')?.text ?? '';
}

function payload(cwd: string, prompt: string): string {
    return JSON.stringify({
        session_id: 'current-session',
        cwd,
        hook_event_name: 'UserPromptSubmit',
        prompt,
        turn_id: 'turn-1',
        model: 'gpt-5.6',
        permission_mode: 'default',
        transcript_path: null,
    });
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

describe('D53 purge tombstones', () => {
    let daemon: IngestionDaemon | undefined;
    let previousCodexHome: string | undefined;

    afterEach(async () => {
        await daemon?.stop();
        if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
        else process.env.CODEX_HOME = previousCodexHome;
    });

    it('keeps a selectively purged, still-consented transcript absent after a restart sweep and across read surfaces', async () => {
        const root = mkdtempSync(path.join(tmpdir(), 'elepha-purge-tombstone-'));
        const dbPath = path.join(root, 'elepha.db');
        const codexHome = path.join(root, '.codex');
        const sessionsRoot = path.join(codexHome, 'sessions');
        const project = process.cwd();
        const rollout = path.join(sessionsRoot, '2026', '08', '11', path.basename(SOURCE_FIXTURE));
        mkdirSync(path.dirname(rollout), { recursive: true });
        copyFileSync(SOURCE_FIXTURE, rollout);
        writeFileSync(rollout, readFileSync(rollout, 'utf8').replaceAll('/Users/test/demo-project', project));
        previousCodexHome = process.env.CODEX_HOME;
        process.env.CODEX_HOME = codexHome;

        const initialLogs: string[] = [];
        const store = new MemoryStore(openDb(dbPath), { resolveGitRoot: () => null, resolveGitRemote: () => null });
        store.consent.grant(project);
        daemon = new IngestionDaemon({
            store,
            watchRoots: [sessionsRoot],
            heartbeatPath: path.join(root, 'daemon.heartbeat.json'),
            watcherUsePolling: true,
            log: (message) => initialLogs.push(message),
        });
        daemon.start();
        await waitFor(() => initialLogs.some((message) => message.startsWith('[elepha] startup sweep:')));

        const purged = store.findSession('codex', NATIVE_ID);
        expect(purged, initialLogs.join('\n')).toBeDefined();
        store.database
            .prepare("UPDATE sessions SET title = 'Purged session', last_ingested_at = ? WHERE id = ?")
            .run('2026-08-20T00:00:00.000Z', purged!.id);

        // Keep the project row and consent intact: only the selected transcript
        // is removed, so the read surfaces prove absence rather than a missing project.
        const retained = store.upsertSession('codex', 'retained-session', purged!.project_id, rollout);
        const retainedTurn: ParsedTurn = {
            tool: 'codex',
            sessionId: 'retained-session',
            sourcePath: rollout,
            projectPath: project,
            turnIndex: 0,
            startedAt: '2026-08-20T01:00:00.000Z',
            endedAt: '2026-08-20T01:00:01.000Z',
            userMessage: 'keep this session',
            assistantText: 'retained',
            toolCalls: [],
            cursor: 'retained|1',
            hasExternalContent: false,
            resumeMarkerBefore: false,
        };
        store.recordTurn(retainedTurn, retained.id, purged!.project_id, { decisions: [], pending_items: [], status: 'ok' });
        store.database
            .prepare("UPDATE sessions SET title = 'Retained session', last_ingested_at = ? WHERE id = ?")
            .run('2026-08-22T00:00:00.000Z', retained.id);

        const cutoff = '2026-08-21T00:00:00.000Z';
        store.purge({ olderThan: cutoff }, cutoff);
        expect(store.findSession('codex', NATIVE_ID)).toBeUndefined();
        expect(store.findSession('codex', 'retained-session')).toBeDefined();
        expect(store.consent.isConsented(project)).toBe(true);
        expect(store.isTranscriptPurged('codex', NATIVE_ID)).toBe(true);

        await daemon.stop();
        daemon = undefined;
        store.database.close();

        const restartLogs: string[] = [];
        const restartedStore = new MemoryStore(openDb(dbPath), { resolveGitRoot: () => null, resolveGitRemote: () => null });
        daemon = new IngestionDaemon({
            store: restartedStore,
            watchRoots: [sessionsRoot],
            heartbeatPath: path.join(root, 'daemon-restarted.heartbeat.json'),
            watcherUsePolling: true,
            log: (message) => restartLogs.push(message),
        });
        daemon.start();
        await waitFor(() => restartLogs.some((message) => message.startsWith('[elepha] startup sweep:')));

        expect(restartedStore.findSession('codex', NATIVE_ID)).toBeUndefined();
        expect(restartLogs).toContain(`[elepha] startup sweep: scanned 1 file(s), ingested 0 turn(s), skipped 1 file(s) (purged: 1)`);

        const publicId = Buffer.from(JSON.stringify({ tool: 'codex', nativeId: NATIVE_ID, segmentIndex: 0 })).toString('base64url');
        const mcpDb = openMcpReadOnlyDatabase(dbPath);
        const mcp = new ElephaMcpService(mcpDb);
        const listed = mcp.listSessions({ project, include_all: true });
        expect(text(listed)).toContain('Retained session');
        expect(text(listed)).not.toContain('Purged session');
        expect(text(await mcp.getSession({ id: publicId }))).toContain('No stored episode matches');
        mcpDb.close();

        const last = await runUserPromptSubmit(payload(project, 'elepha:last'), 'codex', {
            dbPath,
            now: () => Date.parse('2026-08-23T00:00:00.000Z'),
        });
        const list = await runUserPromptSubmit(payload(project, 'elepha:list'), 'codex', {
            dbPath,
            now: () => Date.parse('2026-08-23T00:00:00.000Z'),
        });
        expect('output' in last, JSON.stringify(last)).toBe(true);
        expect('output' in list, JSON.stringify(list)).toBe(true);
        if ('output' in last && 'output' in list) {
            const lastContext = (last.output.hookSpecificOutput as Record<string, string>).additionalContext;
            const listContext = (list.output.hookSpecificOutput as Record<string, string>).additionalContext;
            expect(lastContext).toContain('Retained session');
            expect(listContext).toContain('Retained session');
            expect(`${lastContext}\n${listContext}`).not.toContain('Purged session');
        }
    });
});
