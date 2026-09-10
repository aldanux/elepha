import { createHash } from 'node:crypto';
import type { FileHandle } from 'node:fs/promises';
import { FINGERPRINT_WINDOW_BYTES } from '../config/constants.js';

export interface SourceCheckpoint {
    offset: number;
    dev: number;
    ino: number;
    head: string;
    tail: string;
}

async function windowDigest(handle: FileHandle, start: number, length: number): Promise<string> {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    return createHash('sha256').update(buffer.subarray(0, bytesRead)).digest('hex');
}

// Pi and other mutable JSONL sources can share identity/overlap checks without
// sharing provider-specific event reduction or branch selection.
export async function sourceCheckpoint(handle: FileHandle, offset: number): Promise<SourceCheckpoint> {
    const stat = await handle.stat();
    const length = Math.min(offset, FINGERPRINT_WINDOW_BYTES);
    return {
        offset,
        dev: stat.dev,
        ino: stat.ino,
        head: await windowDigest(handle, 0, length),
        tail: await windowDigest(handle, offset - length, length),
    };
}

export async function checkpointMatches(handle: FileHandle, expected: SourceCheckpoint): Promise<boolean> {
    if (!Number.isSafeInteger(expected.offset) || expected.offset < 0 || expected.offset > (await handle.stat()).size) {
        return false;
    }
    const actual = await sourceCheckpoint(handle, expected.offset);
    return actual.dev === expected.dev && actual.ino === expected.ino && actual.head === expected.head && actual.tail === expected.tail;
}
