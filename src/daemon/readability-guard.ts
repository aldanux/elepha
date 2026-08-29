import { open as fsOpen } from 'node:fs/promises';
import { READABILITY_FIRST_LINE_CAP_BYTES, READABILITY_READ_CHUNK_BYTES } from '../config/constants.js';

const NEWLINE_BYTE = 0x0a;

export type FileSkipCategory =
    | 'capture disabled'
    | 'refused root'
    | 'purged'
    | 'incognito'
    | 'unreadable content'
    | 'oversized record'
    | 'zero parsed turns'
    | 'excluded session'
    | 'unexpected error'
    | 'outside watched store'
    | 'unapproved root';

export interface FileSkip {
    category: FileSkipCategory;
    reason: string;
}

function looksCompressed(bytes: Buffer): boolean {
    // zstd magic 0x28 B5 2F FD, gzip 0x1F 8B, zlib 0x78.
    return (
        (bytes[0] === 0x28 && bytes[1] === 0xb5 && bytes[2] === 0x2f && bytes[3] === 0xfd) ||
        (bytes[0] === 0x1f && bytes[1] === 0x8b) ||
        bytes[0] === 0x78
    );
}

function containsBinaryBytes(bytes: Buffer): boolean {
    // JSON permits tabs, CR and LF as whitespace, but no other C0 controls
    // or DEL. Bytes >= 0x80 can be valid UTF-8 and must remain allowed.
    return bytes.some((byte) => (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d) || byte === 0x7f);
}

export class ReadabilityGuard {
    private readonly readabilityChecked = new Set<string>();

    /**
     * File-level readability guard. warnUnknownLine() cannot cover this: it
     * fires per parsed LINE, so a transcript we can't tokenize at all (a
     * compressed .zst rollout, a binary/rotated file) produces zero warnings
     * and zero rows - indistinguishable from an idle session. Codex has
     * shipped compressed rollouts before; if that returns, this is what says
     * so out loud instead of the watcher going quietly empty.
     */
    async assertReadableJsonl(filePath: string): Promise<FileSkip | undefined> {
        if (this.readabilityChecked.has(filePath)) {
            return;
        }

        const handle = await fsOpen(filePath, 'r').catch(() => undefined);
        if (!handle) {
            return { category: 'unreadable content', reason: 'not readable as plain-text JSONL: could not open file' };
        }
        try {
            const chunks: Buffer[] = [];
            let bytesReadTotal = 0;
            let firstNewline = -1;

            while (bytesReadTotal < READABILITY_FIRST_LINE_CAP_BYTES && firstNewline === -1) {
                const remaining = READABILITY_FIRST_LINE_CAP_BYTES - bytesReadTotal;
                const buf = Buffer.alloc(Math.min(READABILITY_READ_CHUNK_BYTES, remaining));
                const { bytesRead } = await handle.read(buf, 0, buf.length, bytesReadTotal);
                if (bytesRead === 0) {
                    break;
                }
                const chunk = buf.subarray(0, bytesRead);
                chunks.push(chunk);
                firstNewline = chunk.indexOf(NEWLINE_BYTE);
                bytesReadTotal += bytesRead;
                if (firstNewline !== -1) {
                    firstNewline += bytesReadTotal - bytesRead;
                }
            }

            if (bytesReadTotal === 0) {
                return;
            }
            this.readabilityChecked.add(filePath);

            if (firstNewline === -1 && bytesReadTotal === READABILITY_FIRST_LINE_CAP_BYTES) {
                return {
                    category: 'unreadable content',
                    reason:
                        `not readable as plain-text JSONL: no newline found within the ${READABILITY_FIRST_LINE_CAP_BYTES}-byte readability cap - ` +
                        'this file will produce NO memory rows until support is added',
                };
            }

            const prefix = Buffer.concat(chunks, bytesReadTotal);
            const firstLine = prefix.subarray(0, firstNewline === -1 ? bytesReadTotal : firstNewline);
            const compressed = looksCompressed(firstLine);
            if (compressed || containsBinaryBytes(firstLine)) {
                return {
                    category: 'unreadable content',
                    reason:
                        `not readable as plain-text JSONL: ` +
                        `${compressed ? 'compressed content detected (looks compressed)' : 'binary content detected'} - ` +
                        'this file will produce NO memory rows until support is added',
                };
            }

            try {
                JSON.parse(firstLine.toString('utf8'));
            } catch {
                return {
                    category: 'unreadable content',
                    reason: 'not readable as plain-text JSONL: first line is not valid JSON - this file will produce NO memory rows until support is added',
                };
            }
        } finally {
            await handle.close();
        }
    }
}
