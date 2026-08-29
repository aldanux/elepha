import { writeFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { OversizedTranscriptRecordError, readBoundedLines } from '../../src/adapters/base.js';
import { ClaudeCodeAdapter } from '../../src/adapters/claude-code.js';
import { CodexAdapter } from '../../src/adapters/codex.js';
import { withTempDir } from '../helpers/tmp.js';

const { readHighWaterByPath, injectedMaxRecordBytes } = vi.hoisted(() => ({
    readHighWaterByPath: new Map<string, number>(),
    injectedMaxRecordBytes: 128,
}));
const TEST_MAX_RECORD_BYTES = injectedMaxRecordBytes;

vi.mock('../../src/config/constants.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../src/config/constants.js')>();
    return { ...actual, MAX_TRANSCRIPT_RECORD_BYTES: injectedMaxRecordBytes };
});

vi.mock('node:fs/promises', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:fs/promises')>();
    return {
        ...actual,
        open: async (...args: Parameters<typeof actual.open>) => {
            const filePath = String(args[0]);
            const handle = await actual.open(...args);
            return new Proxy(handle, {
                get(target, property) {
                    if (property === 'read') {
                        return async (buffer: Buffer, offset: number, length: number, position: number) => {
                            const result = await target.read(buffer, offset, length, position);
                            readHighWaterByPath.set(
                                filePath,
                                Math.max(readHighWaterByPath.get(filePath) ?? 0, position + result.bytesRead),
                            );
                            return result;
                        };
                    }
                    const value = Reflect.get(target, property, target);
                    return typeof value === 'function' ? value.bind(target) : value;
                },
            });
        },
    };
});

function oversizedTranscript(prefix: unknown): { filePath: string; oversizedRecordStart: number } {
    const directory = withTempDir('elepha-pre-reader-bounds-');
    const filePath = path.join(directory, 'transcript.jsonl');
    const firstRecord = `${JSON.stringify(prefix)}\n`;
    writeFileSync(filePath, `${firstRecord}${'x'.repeat(TEST_MAX_RECORD_BYTES * 20)}`);
    return { filePath, oversizedRecordStart: Buffer.byteLength(firstRecord) };
}

async function expectBoundedOversizedThrow(filePath: string, oversizedRecordStart: number, read: () => Promise<unknown>): Promise<void> {
    await expect(read()).rejects.toBeInstanceOf(OversizedTranscriptRecordError);
    const highWater = readHighWaterByPath.get(filePath);
    expect(highWater).toBeDefined();
    expect(highWater).toBeLessThanOrEqual(oversizedRecordStart + TEST_MAX_RECORD_BYTES + 1);
    expect(highWater).toBeLessThan(Buffer.byteLength(`${'x'.repeat(TEST_MAX_RECORD_BYTES * 20)}`) + oversizedRecordStart);
}

type CodexPreReaderSeam = {
    readClassificationPreamble(filePath: string): Promise<unknown>;
    userBoundaryFor(filePath: string): Promise<unknown>;
};

describe('bounded adapter pre-readers', () => {
    it('throws while the shared empty-session classifier is still reading the oversized record', async () => {
        const { filePath, oversizedRecordStart } = oversizedTranscript({ type: 'user', message: { role: 'user', content: 'safe' } });

        await expectBoundedOversizedThrow(filePath, oversizedRecordStart, () => new ClaudeCodeAdapter().classifyEmptySession(filePath));
    });

    it('throws while the Claude custom-title reader is still reading the oversized record', async () => {
        const { filePath, oversizedRecordStart } = oversizedTranscript({ type: 'custom-title', customTitle: 'Safe title' });

        await expectBoundedOversizedThrow(filePath, oversizedRecordStart, () => new ClaudeCodeAdapter().readCustomTitle(filePath));
    });

    it('throws while the Codex classification preamble reader is still reading the oversized record', async () => {
        const { filePath, oversizedRecordStart } = oversizedTranscript({ type: 'session_meta', payload: { cwd: '/tmp/project' } });
        const adapter = new CodexAdapter() as unknown as CodexPreReaderSeam;

        await expectBoundedOversizedThrow(filePath, oversizedRecordStart, () => adapter.readClassificationPreamble(filePath));
    });

    it('throws while the Codex user-boundary reader is still reading the oversized record', async () => {
        const { filePath, oversizedRecordStart } = oversizedTranscript({ type: 'session_meta', payload: { cwd: '/tmp/project' } });
        const adapter = new CodexAdapter() as unknown as CodexPreReaderSeam;

        await expectBoundedOversizedThrow(filePath, oversizedRecordStart, () => adapter.userBoundaryFor(filePath));
    });

    it('honours an explicitly injected maxRecordBytes in the shared reader', async () => {
        const directory = withTempDir('elepha-bounded-lines-option-');
        const filePath = path.join(directory, 'transcript.jsonl');
        writeFileSync(filePath, 'x'.repeat(1024));

        const consume = async () => {
            for await (const _line of readBoundedLines(filePath, { maxRecordBytes: 17 })) {
                // No complete line is expected before the oversized throw.
            }
        };

        await expect(consume()).rejects.toBeInstanceOf(OversizedTranscriptRecordError);
        expect(readHighWaterByPath.get(filePath)).toBeLessThanOrEqual(18);
    });

    it('uses positional reads on a supplied handle without closing it or disturbing its position', async () => {
        const directory = withTempDir('elepha-bounded-lines-handle-');
        const filePath = path.join(directory, 'transcript.jsonl');
        writeFileSync(filePath, 'a\nb\n');
        const handle = await open(filePath, 'r');
        const firstByte = Buffer.alloc(1);
        await handle.read(firstByte, 0, 1, null);

        const lines: string[] = [];
        for await (const line of readBoundedLines(filePath, { handle })) {
            lines.push(line.text);
        }
        const nextByte = Buffer.alloc(1);
        await handle.read(nextByte, 0, 1, null);

        expect(lines).toEqual(['a', 'b']);
        expect(firstByte.toString()).toBe('a');
        expect(nextByte.toString()).toBe('\n');
        await handle.close();
    });
});
