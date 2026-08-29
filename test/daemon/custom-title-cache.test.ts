import { appendFileSync, mkdtempSync, readFileSync, truncateSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { IngestionDaemon } from '../../src/daemon/index.js';
import { openDb } from '../../src/storage/db.js';
import { MemoryStore } from '../../src/storage/memory-store.js';
import type { EmptySessionAnalysis, ParsedTurn, SessionAdapter, SessionClassification } from '../../src/types/index.js';

class TitleAdapter implements SessionAdapter {
    readonly tool = 'claude-code' as const;
    readonly watchGlobs = ['*.jsonl'];
    readonly titleReadOffsets: number[] = [];

    matches(): boolean {
        return true;
    }

    nativeSessionId(): string {
        return 'custom-title-cache';
    }

    async classifySession(): Promise<SessionClassification> {
        return { kind: 'primary' };
    }

    async classifyEmptySession(): Promise<EmptySessionAnalysis | undefined> {
        return undefined;
    }

    async readCustomTitle(filePath: string, fromOffset = 0): Promise<{ customTitle?: string; scannedTo: number }> {
        this.titleReadOffsets.push(fromOffset);
        const region = readFileSync(filePath).subarray(fromOffset);
        const lastNewline = region.lastIndexOf(0x0a);
        if (lastNewline === -1) {
            return { scannedTo: fromOffset };
        }

        let customTitle: string | undefined;
        for (const text of region
            .subarray(0, lastNewline + 1)
            .toString('utf8')
            .split('\n')) {
            try {
                const line = JSON.parse(text) as { type?: unknown; customTitle?: unknown };
                if (line.type === 'custom-title' && typeof line.customTitle === 'string') {
                    customTitle = line.customTitle;
                }
            } catch {
                // The adapter fixture deliberately follows the production malformed-line contract.
            }
        }
        return customTitle === undefined
            ? { scannedTo: fromOffset + lastNewline + 1 }
            : { customTitle, scannedTo: fromOffset + lastNewline + 1 };
    }

    async *parseTurns(): AsyncIterable<ParsedTurn> {}
}

type CustomTitleSeam = {
    readCustomTitle(adapter: SessionAdapter, filePath: string): Promise<string | undefined>;
};

function setup(): { adapter: TitleAdapter; daemon: CustomTitleSeam; filePath: string } {
    const directory = mkdtempSync(path.join(tmpdir(), 'elepha-custom-title-cache-'));
    const filePath = path.join(directory, 'session.jsonl');
    const adapter = new TitleAdapter();
    const daemon = new IngestionDaemon({ store: new MemoryStore(openDb(':memory:')), adapters: [adapter] }) as unknown as CustomTitleSeam;
    return { adapter, daemon, filePath };
}

function customTitle(title: string): string {
    return `${JSON.stringify({ type: 'custom-title', customTitle: title })}\n`;
}

describe('daemon custom-title cache', () => {
    it('returns the cached title without opening the transcript when its size and mtime are unchanged', async () => {
        const { adapter, daemon, filePath } = setup();
        writeFileSync(filePath, customTitle('Initial title'));

        await expect(daemon.readCustomTitle(adapter, filePath)).resolves.toBe('Initial title');
        await expect(daemon.readCustomTitle(adapter, filePath)).resolves.toBe('Initial title');

        expect(adapter.titleReadOffsets).toEqual([0]);
    });

    it('reads only the appended region and retains the prior title when an append has no new title', async () => {
        const { adapter, daemon, filePath } = setup();
        writeFileSync(filePath, customTitle('Initial title'));
        await daemon.readCustomTitle(adapter, filePath);
        const firstScannedTo = readFileSync(filePath).byteLength;

        appendFileSync(filePath, customTitle('Updated title'));
        await expect(daemon.readCustomTitle(adapter, filePath)).resolves.toBe('Updated title');
        expect(adapter.titleReadOffsets).toEqual([0, firstScannedTo]);
        await expect(adapter.readCustomTitle(filePath)).resolves.toMatchObject({ customTitle: 'Updated title' });

        appendFileSync(filePath, `${JSON.stringify({ type: 'assistant' })}\n`);
        await expect(daemon.readCustomTitle(adapter, filePath)).resolves.toBe('Updated title');
        expect(adapter.titleReadOffsets.at(-1)).toBeGreaterThan(0);
        await expect(adapter.readCustomTitle(filePath)).resolves.toMatchObject({ customTitle: 'Updated title' });
    });

    it('re-reads from the beginning when a replacement has an older mtime', async () => {
        const { adapter, daemon, filePath } = setup();
        writeFileSync(filePath, `${customTitle('Original title')}${' '.repeat(128)}\n`);
        await daemon.readCustomTitle(adapter, filePath);

        writeFileSync(filePath, customTitle('Replacement title'));
        utimesSync(filePath, new Date(0), new Date(0));
        await expect(daemon.readCustomTitle(adapter, filePath)).resolves.toBe('Replacement title');

        expect(adapter.titleReadOffsets.at(-1)).toBe(0);
    });

    it('re-reads from the beginning when truncation leaves bytes beyond the prior scan boundary', async () => {
        const { adapter, daemon, filePath } = setup();
        writeFileSync(filePath, `${customTitle('Original title')}${JSON.stringify({ type: 'assistant' })}`);
        await daemon.readCustomTitle(adapter, filePath);
        const initialSize = readFileSync(filePath).byteLength;

        truncateSync(filePath, initialSize - 1);
        utimesSync(filePath, new Date(), new Date(Date.now() + 1_000));
        await expect(daemon.readCustomTitle(adapter, filePath)).resolves.toBe('Original title');

        expect(adapter.titleReadOffsets.at(-1)).toBe(0);
    });
});
