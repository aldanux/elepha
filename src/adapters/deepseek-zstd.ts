import { createHash } from 'node:crypto';
import type { FileHandle } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { createZstdDecompress } from 'node:zlib';
import { MAX_TRANSCRIPT_RECORD_BYTES, READABILITY_READ_CHUNK_BYTES } from '../config/constants.js';
import { OversizedTranscriptRecordError } from './base.js';

const ZSTD_MAGIC = 0xfd2fb528;
const ZSTD_MAGIC_BYTES = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const ZSTD_MAX_BLOCK_BYTES = 128 * 1024;
const NEWLINE_BYTE = 0x0a;

export type DeepSeekEncoding = 'raw' | 'zstd';

export interface DeepSeekRecordLine {
    text: string;
    resumeOffset: number;
}

interface ZstdFrame {
    start: number;
    end: number;
}

async function readAt(handle: FileHandle, offset: number, length: number, fileSize: number): Promise<Buffer | undefined> {
    if (offset + length > fileSize) {
        return undefined;
    }
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, offset);
    return bytesRead === length ? buffer : undefined;
}

function dictionaryIdSize(flag: number): number {
    return [0, 1, 2, 4][flag] ?? 0;
}

function frameContentSizeBytes(descriptor: number): number {
    const flag = descriptor >>> 6;
    if (flag === 0) {
        return descriptor & 0x20 ? 1 : 0;
    }
    return flag === 1 ? 2 : flag === 2 ? 4 : 8;
}

// Locates complete independent frames from their bounded structural fields.
// Payload bytes are never retained here; each complete range is decoded by a
// fresh in-process stream so a torn crash tail cannot consume the next scan.
async function* scanZstdFrames(handle: FileHandle, start = 0): AsyncIterable<ZstdFrame> {
    const fileSize = (await handle.stat()).size;
    let offset = start;
    while (offset < fileSize) {
        const magic = await readAt(handle, offset, 4, fileSize);
        if (!magic) {
            return;
        }
        if (magic.readUInt32LE(0) !== ZSTD_MAGIC) {
            throw new Error(`invalid Zstandard frame magic at byte ${offset}`);
        }

        const descriptorBytes = await readAt(handle, offset + 4, 1, fileSize);
        if (!descriptorBytes) {
            return;
        }
        const descriptor = descriptorBytes[0] ?? 0;
        if (descriptor & 0x08) {
            throw new Error(`reserved Zstandard frame descriptor bit set at byte ${offset + 4}`);
        }
        if (!(descriptor & 0x04)) {
            throw new Error(`DeepSeek Zstandard frame at byte ${offset} is missing its content checksum`);
        }
        const headerBytes = 1 + (descriptor & 0x20 ? 0 : 1) + dictionaryIdSize(descriptor & 0x03) + frameContentSizeBytes(descriptor);
        if (!(await readAt(handle, offset + 4, headerBytes, fileSize))) {
            return;
        }

        let blockOffset = offset + 4 + headerBytes;
        for (;;) {
            const blockHeader = await readAt(handle, blockOffset, 3, fileSize);
            if (!blockHeader) {
                return;
            }
            const value = blockHeader.readUIntLE(0, 3);
            const last = (value & 1) === 1;
            const blockType = (value >>> 1) & 0x03;
            const blockSize = value >>> 3;
            if (blockType === 3) {
                throw new Error(`reserved Zstandard block type at byte ${blockOffset}`);
            }
            if (blockSize > ZSTD_MAX_BLOCK_BYTES) {
                throw new Error(`invalid Zstandard block size ${blockSize} at byte ${blockOffset}`);
            }
            const payloadBytes = blockType === 1 ? 1 : blockSize;
            if (blockOffset + 3 + payloadBytes > fileSize) {
                return;
            }
            blockOffset += 3 + payloadBytes;
            if (!last) {
                continue;
            }
            if (blockOffset + 4 > fileSize) {
                return;
            }
            const end = blockOffset + 4;
            yield { start: offset, end };
            offset = end;
            break;
        }
    }
}

async function* decodedFrameChunks(handle: FileHandle, frame: ZstdFrame): AsyncIterable<Buffer> {
    const range = async function* () {
        let offset = frame.start;
        while (offset < frame.end) {
            const chunk = Buffer.alloc(Math.min(READABILITY_READ_CHUNK_BYTES, frame.end - offset));
            const { bytesRead } = await handle.read(chunk, 0, chunk.length, offset);
            if (bytesRead === 0) {
                throw new Error(`DeepSeek Zstandard frame changed while reading at byte ${offset}`);
            }
            offset += bytesRead;
            yield chunk.subarray(0, bytesRead);
        }
    };
    const input = Readable.from(range());
    const decoder = createZstdDecompress();
    input.pipe(decoder);
    try {
        for await (const chunk of decoder) {
            yield Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        }
    } finally {
        input.destroy();
        decoder.destroy();
    }
}

async function* splitDecodedFrame(handle: FileHandle, frame: ZstdFrame): AsyncIterable<DeepSeekRecordLine> {
    let pending: Buffer[] = [];
    let pendingBytes = 0;
    for await (const chunk of decodedFrameChunks(handle, frame)) {
        let lineStart = 0;
        for (;;) {
            const newline = chunk.indexOf(NEWLINE_BYTE, lineStart);
            if (newline === -1) {
                const tail = chunk.subarray(lineStart);
                if (pendingBytes + tail.length > MAX_TRANSCRIPT_RECORD_BYTES) {
                    throw new OversizedTranscriptRecordError();
                }
                if (tail.length > 0) {
                    pending.push(tail);
                    pendingBytes += tail.length;
                }
                break;
            }
            const tail = chunk.subarray(lineStart, newline);
            const recordBytes = pendingBytes + tail.length;
            if (recordBytes > MAX_TRANSCRIPT_RECORD_BYTES) {
                throw new OversizedTranscriptRecordError();
            }
            const record = pending.length === 0 ? tail : Buffer.concat(tail.length === 0 ? pending : [...pending, tail], recordBytes);
            yield { text: record.toString('utf8'), resumeOffset: frame.start };
            pending = [];
            pendingBytes = 0;
            lineStart = newline + 1;
        }
    }
    if (pendingBytes > 0) {
        throw new Error(`complete Zstandard frame at byte ${frame.start} ends with an incomplete JSONL record`);
    }
}

export async function hasZstdMagic(handle: FileHandle): Promise<boolean> {
    const bytes = Buffer.alloc(ZSTD_MAGIC_BYTES.length);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    return bytesRead === bytes.length && bytes.equals(ZSTD_MAGIC_BYTES);
}

export async function* readDeepSeekZstdLines(handle: FileHandle, start = 0): AsyncIterable<DeepSeekRecordLine> {
    for await (const frame of scanZstdFrames(handle, start)) {
        yield* splitDecodedFrame(handle, frame);
    }
}

export async function readDeepSeekZstdHeaderLine(handle: FileHandle): Promise<string | undefined> {
    const frames = scanZstdFrames(handle);
    const first = await frames[Symbol.asyncIterator]().next();
    if (first.done) {
        return undefined;
    }
    const lines: string[] = [];
    for await (const line of splitDecodedFrame(handle, first.value)) {
        lines.push(line.text);
        if (lines.length > 1) {
            break;
        }
    }
    if (lines.length !== 1) {
        throw new Error('DeepSeek Zstandard frame 0 must contain exactly one session header line');
    }
    return lines[0];
}

export function deepSeekHeaderHash(line: string): string {
    return createHash('sha256').update(line).digest('hex');
}
