import { appendFileSync, createReadStream, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ClaudeCodeAdapter } from '../../src/adapters/claude-code.js';
import { CodexAdapter } from '../../src/adapters/codex.js';
import type { ParsedTurn } from '../../src/types/index.js';

const CUSTOM_TITLE = path.join(__dirname, '..', 'fixtures', 'claude-code', 'claude-v2.1.229-custom-title.jsonl');
const FRAME_LINK = path.join(__dirname, '..', 'fixtures', 'claude-code', 'claude-v2.1.232-frame-link.jsonl');
const AGENT_REASONING = path.join(__dirname, '..', 'fixtures', 'codex', 'rollout-codex-v0.148.0-alpha.9-agent-reasoning.jsonl');

async function collect(iter: AsyncIterable<ParsedTurn>): Promise<ParsedTurn[]> {
    const turns: ParsedTurn[] = [];
    for await (const turn of iter) turns.push(turn);
    return turns;
}

async function legacyCustomTitleResult(filePath: string, fromOffset = 0): Promise<{ customTitle?: string; scannedTo: number }> {
    const input = createReadStream(filePath, { encoding: 'utf8', start: fromOffset });
    let customTitle: string | undefined;
    let remainder = '';
    let scannedTo = fromOffset;
    try {
        for await (const chunk of input) {
            remainder += chunk;
            let newlineAt = remainder.indexOf('\n');
            while (newlineAt !== -1) {
                const text = remainder.slice(0, newlineAt);
                remainder = remainder.slice(newlineAt + 1);
                scannedTo += Buffer.byteLength(`${text}\n`, 'utf8');
                try {
                    const line = JSON.parse(text) as { type?: unknown; customTitle?: unknown };
                    if (line.type === 'custom-title' && typeof line.customTitle === 'string') {
                        customTitle = line.customTitle;
                    }
                } catch {
                    // Frozen reference behavior: malformed complete lines are consumed and ignored.
                }
                newlineAt = remainder.indexOf('\n');
            }
        }
    } finally {
        input.destroy();
    }
    return customTitle === undefined ? { scannedTo } : { customTitle, scannedTo };
}

describe('recognized transcript decoration and metadata line types', () => {
    // Trimmed real samples, genericized only for content/identifiers. The
    // filenames retain the distinct source versions of each fixture.
    it('explicitly excludes frame-link UI decoration without a warning or turn-output change', async () => {
        const warn = vi.fn();
        const turns = await collect(new ClaudeCodeAdapter(warn).parseTurns(FRAME_LINK, undefined, { closeTrailingOnIdle: true }));

        expect(warn).not.toHaveBeenCalled();
        expect(turns).toHaveLength(1);
        expect(turns[0]?.assistantText).toBe('The review is ready.');
    });

    it('captures custom-title as session metadata without a warning or turn-output change', async () => {
        const warn = vi.fn();
        const adapter = new ClaudeCodeAdapter(warn);
        const turns = await collect(adapter.parseTurns(CUSTOM_TITLE, undefined, { closeTrailingOnIdle: true }));

        expect(warn).not.toHaveBeenCalled();
        expect(await adapter.readCustomTitle(CUSTOM_TITLE)).toEqual({
            customTitle: 'Latest project changelog',
            scannedTo: readFileSync(CUSTOM_TITLE).byteLength,
        });
        expect(turns).toHaveLength(1);
        expect(turns[0]?.userMessage).toBe('Read the latest changelog');
        expect(turns[0]?.assistantText).toBe('I found the latest changelog.');
    });

    it('reads complete custom-title lines incrementally and leaves a partial append for the next scan', async () => {
        const filePath = path.join(mkdtempSync(path.join(tmpdir(), 'elepha-custom-title-')), 'session.jsonl');
        const adapter = new ClaudeCodeAdapter();
        writeFileSync(filePath, `${JSON.stringify({ type: 'user' })}\n`);

        const initial = await adapter.readCustomTitle(filePath);
        expect(initial).toEqual({ scannedTo: readFileSync(filePath).byteLength });

        appendFileSync(filePath, `${JSON.stringify({ type: 'custom-title', customTitle: 'First title' })}\n`);
        const titled = await adapter.readCustomTitle(filePath, initial.scannedTo);
        expect(titled).toEqual({ customTitle: 'First title', scannedTo: readFileSync(filePath).byteLength });
        expect(await adapter.readCustomTitle(filePath)).toEqual(titled);

        appendFileSync(filePath, `${JSON.stringify({ type: 'assistant' })}\n`);
        const withoutNewTitle = await adapter.readCustomTitle(filePath, titled.scannedTo);
        expect(withoutNewTitle).toEqual({ scannedTo: readFileSync(filePath).byteLength });
        expect(withoutNewTitle.customTitle ?? titled.customTitle).toBe('First title');
        expect((await adapter.readCustomTitle(filePath)).customTitle).toBe('First title');

        appendFileSync(filePath, JSON.stringify({ type: 'custom-title', customTitle: 'Second title' }));
        const partial = await adapter.readCustomTitle(filePath, withoutNewTitle.scannedTo);
        expect(partial).toEqual({ scannedTo: withoutNewTitle.scannedTo });
        expect(partial.customTitle ?? titled.customTitle).toBe('First title');
        expect((await adapter.readCustomTitle(filePath)).customTitle).toBe('First title');

        appendFileSync(filePath, '\n');
        const completed = await adapter.readCustomTitle(filePath, partial.scannedTo);
        expect(completed).toEqual({ customTitle: 'Second title', scannedTo: readFileSync(filePath).byteLength });
        expect((await adapter.readCustomTitle(filePath)).customTitle).toBe(completed.customTitle);
    });

    it('keeps customTitle and scannedTo byte-identical to the previous reader from zero and a resumed offset', async () => {
        const filePath = path.join(mkdtempSync(path.join(tmpdir(), 'elepha-custom-title-offset-')), 'session.jsonl');
        const firstLine = `${JSON.stringify({ type: 'user', message: { content: 'Multibyte é🙂' } })}\n`;
        writeFileSync(
            filePath,
            `${firstLine}{malformed but complete}\n${JSON.stringify({ type: 'custom-title', customTitle: 'Título 🚀' })}\n${JSON.stringify({
                type: 'assistant',
            })}\n${JSON.stringify({ type: 'custom-title', customTitle: 'partial title' })}`,
        );
        const adapter = new ClaudeCodeAdapter();
        const resumedFrom = Buffer.byteLength(firstLine);

        await expect(adapter.readCustomTitle(filePath)).resolves.toEqual(await legacyCustomTitleResult(filePath));
        await expect(adapter.readCustomTitle(filePath, resumedFrom)).resolves.toEqual(await legacyCustomTitleResult(filePath, resumedFrom));
    });

    it('explicitly excludes agent_reasoning TUI headers without a warning or assistant-output change', async () => {
        const warn = vi.fn();
        const turns = await collect(new CodexAdapter(warn).parseTurns(AGENT_REASONING, undefined, { closeTrailingOnIdle: true }));

        expect(warn).not.toHaveBeenCalled();
        expect(turns).toHaveLength(1);
        expect(turns[0]?.assistantText).toBe('The project note is updated.');
    });
});
