import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IngestionDaemon } from '../../src/daemon/index.js';
import { openUnmanagedDb } from '../../src/storage/db.js';
import { MemoryStore } from '../../src/storage/memory-store.js';
import type { ParsedTurn, SessionAdapter } from '../../src/types/index.js';
import { withGrantableTestDir } from '../helpers/tmp.js';

// Yields one turn per transcript, reading the cwd from its first line, and
// throws for a session named "explodes" to model a parser failure.
class ReportAdapter implements SessionAdapter {
    readonly tool = 'claude-code' as const;
    readonly watchGlobs = ['*.jsonl'];

    matches(filePath: string): boolean {
        return path.extname(filePath) === '.jsonl';
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

    async readCustomTitle(): Promise<{ customTitle: string; scannedTo: number }> {
        return { customTitle: 'Title', scannedTo: 1 };
    }

    async *parseTurns(filePath: string): AsyncIterable<ParsedTurn> {
        const sessionId = this.nativeSessionId(filePath);
        if (sessionId === 'explodes') {
            throw new Error('parser crashed on an unknown record');
        }
        const { cwd } = JSON.parse(readFileSync(filePath, 'utf8').split('\n')[0] ?? '{}') as { cwd: string };
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
}

function fixture() {
    const directory = realpathSync(withGrantableTestDir('elepha-backfill-report-'));
    const watchRoot = path.join(directory, '.claude', 'projects');
    vi.stubEnv('CLAUDE_CONFIG_DIR', path.dirname(watchRoot));
    mkdirSync(watchRoot, { recursive: true });
    const root = path.join(directory, 'approved');
    mkdirSync(root);
    const store = new MemoryStore(openUnmanagedDb(path.join(directory, 'elepha.db')));
    store.consent.grant(root);
    const transcript = (sessionId: string, firstLine: string): string => {
        const file = path.join(watchRoot, `${sessionId}.jsonl`);
        writeFileSync(file, `${firstLine}\n`);
        return file;
    };
    const memories = () => (store.database.prepare('SELECT COUNT(*) AS count FROM memories').get() as { count: number }).count;
    return { directory, watchRoot, root, store, transcript, memories };
}

describe('approved-root backfill report', () => {
    afterEach(() => vi.unstubAllEnvs());

    it('keeps captured turns and names each source it could not read or parse', async () => {
        const f = fixture();
        f.transcript('good', JSON.stringify({ cwd: f.root }));
        const unreadable = f.transcript('garbled', 'this is not json');
        const crashing = f.transcript('explodes', JSON.stringify({ cwd: f.root }));
        const daemon = new IngestionDaemon({ store: f.store, adapters: [new ReportAdapter()], watchRoots: [f.watchRoot] });

        const report = await daemon.backfillApprovedRootsReport([f.root]);

        expect(report.ingested).toBe(1);
        expect(f.memories()).toBe(1);
        expect(report.incomplete).toEqual([
            expect.objectContaining({ source: crashing, category: 'unexpected error' }),
            expect.objectContaining({ source: unreadable, category: 'unreadable content' }),
        ]);
    });

    it('reports a transcript store that cannot be listed', async () => {
        const f = fixture();
        const daemon = new IngestionDaemon({
            store: f.store,
            adapters: [new ReportAdapter()],
            watchRoots: [f.watchRoot],
            readCorpus: async () => {
                throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
            },
        });

        const report = await daemon.backfillApprovedRootsReport([f.root]);

        expect(report).toEqual({
            ingested: 0,
            incomplete: [{ source: f.watchRoot, category: 'listing failed', reason: 'permission denied' }],
        });
    });

    it('treats a missing store and intentionally excluded sessions as complete', async () => {
        const f = fixture();
        const outside = path.join(f.directory, 'not-approved');
        mkdirSync(outside);
        f.transcript('elsewhere', JSON.stringify({ cwd: outside }));
        const daemon = new IngestionDaemon({
            store: f.store,
            adapters: [new ReportAdapter()],
            watchRoots: [f.watchRoot, path.join(f.directory, 'missing-store')],
        });

        const report = await daemon.backfillApprovedRootsReport([f.root]);

        expect(report).toEqual({ ingested: 0, incomplete: [] });
    });
});
