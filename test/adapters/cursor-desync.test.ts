// The byte cursor is a raw offset. If a rewritten/rotated file shrinks
// below it, the old code (`fileStat.size <= startOffset`) returned silently -
// that session is frozen forever with no warning. If the file grows past the
// old offset but the content changed underneath (rotation, compaction), the
// cursor points mid-record: a dropped partial line and drifted turn indices,
// again with no warning. Current formats are append-only so this is latent,
// but nothing would catch it if that changes. The reader must distinguish this
// failure from a legitimately idle session.

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ClaudeCodeAdapter } from '../../src/adapters/claude-code.js';
import type { ParsedTurn } from '../../src/types/index.js';

async function collect(iter: AsyncIterable<ParsedTurn>): Promise<ParsedTurn[]> {
    const out: ParsedTurn[] = [];
    for await (const t of iter) out.push(t);
    return out;
}

function turnLines(idx: number, cwd: string, sessionId: string, userText: string): string {
    const t = (offset: number) => new Date(Date.UTC(2026, 7, 1, 0, 0, idx * 2 + offset)).toISOString();
    const user = JSON.stringify({
        type: 'user',
        parentUuid: idx === 0 ? null : `a${idx - 1}`,
        isSidechain: false,
        message: { role: 'user', content: userText },
        uuid: `u${idx}`,
        timestamp: t(0),
        cwd,
        sessionId,
    });
    const assistant = JSON.stringify({
        type: 'assistant',
        parentUuid: `u${idx}`,
        message: { role: 'assistant', content: [{ type: 'text', text: 'a real reply' }] },
        uuid: `a${idx}`,
        timestamp: t(1),
        cwd,
        sessionId,
    });
    return `${user}\n${assistant}\n`;
}

describe('cursor desync detection', () => {
    it('warns loudly and yields nothing when the file shrinks below the cursor', async () => {
        const root = mkdtempSync(path.join(tmpdir(), 'elepha-desync-'));
        const filePath = path.join(root, 'sess.jsonl');
        writeFileSync(filePath, turnLines(0, root, 'sess-1', 'first') + turnLines(1, root, 'sess-1', 'second'));

        const logs: string[] = [];
        const adapter = new ClaudeCodeAdapter((msg) => logs.push(msg));
        const firstPass = await collect(adapter.parseTurns(filePath, undefined, { closeTrailingOnIdle: true }));
        expect(firstPass).toHaveLength(2);
        const cursor = firstPass[1]?.cursor;

        // Simulate a rotated/truncated file: much shorter than the cursor offset.
        writeFileSync(filePath, 'short\n');

        const secondPass = await collect(adapter.parseTurns(filePath, cursor, { closeTrailingOnIdle: true }));
        expect(secondPass).toHaveLength(0);
        expect(logs.some((l) => /shrink|shrunk|truncat/i.test(l) && l.includes('sess.jsonl'))).toBe(true);
    });

    it('warns loudly and yields nothing when the file is rewritten with different content at a larger size', async () => {
        const root = mkdtempSync(path.join(tmpdir(), 'elepha-desync-'));
        const filePath = path.join(root, 'sess.jsonl');
        writeFileSync(filePath, turnLines(0, root, 'sess-1', 'first'));

        const logs: string[] = [];
        const adapter = new ClaudeCodeAdapter((msg) => logs.push(msg));
        const firstPass = await collect(adapter.parseTurns(filePath, undefined, { closeTrailingOnIdle: true }));
        expect(firstPass).toHaveLength(1);
        const cursor = firstPass[0]?.cursor;

        // Rewritten from scratch with different content at the SAME offset the
        // cursor already passed, then padded past it - looks like legitimate
        // growth by size alone, but the bytes the cursor already trusted changed.
        const rewritten = turnLines(0, root, 'sess-1', 'DIFFERENT CONTENT ENTIRELY, NOT A REAL APPEND') + turnLines(1, root, 'sess-1', 'x');
        writeFileSync(filePath, rewritten);

        const secondPass = await collect(adapter.parseTurns(filePath, cursor, { closeTrailingOnIdle: true }));
        expect(secondPass).toHaveLength(0);
        expect(logs.some((l) => /rewrit|desync|mismatch/i.test(l) && l.includes('sess.jsonl'))).toBe(true);
    });

    it('does not false-positive on a legitimate append', async () => {
        const root = mkdtempSync(path.join(tmpdir(), 'elepha-desync-'));
        const filePath = path.join(root, 'sess.jsonl');
        writeFileSync(filePath, turnLines(0, root, 'sess-1', 'first'));

        const logs: string[] = [];
        const adapter = new ClaudeCodeAdapter((msg) => logs.push(msg));
        const firstPass = await collect(adapter.parseTurns(filePath, undefined, { closeTrailingOnIdle: true }));
        const cursor = firstPass[0]?.cursor;

        // A genuine append: original bytes untouched, new turn added after.
        writeFileSync(filePath, turnLines(0, root, 'sess-1', 'first') + turnLines(1, root, 'sess-1', 'second'), { flag: 'w' });

        const secondPass = await collect(adapter.parseTurns(filePath, cursor, { closeTrailingOnIdle: true }));
        expect(secondPass).toHaveLength(1);
        expect(secondPass[0]?.userMessage).toBe('second');
        expect(logs.some((l) => /shrink|rewrit|desync|mismatch/i.test(l))).toBe(false);
    });
});
