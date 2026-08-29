import { closeSync, openSync, writeSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MAX_METADATA_SCAN_BYTES, MAX_METADATA_SCAN_LINES } from '../../src/config/constants.js';
import { readSessionMetadata } from '../../src/discovery/session-projects.js';
import { withTempDir } from '../helpers/tmp.js';

describe('bounded session metadata discovery', () => {
    it('returns metadata near the top of a transcript', async () => {
        const filePath = path.join(withTempDir('elepha-metadata-bounds-'), 'session.jsonl');
        const cwd = '/Users/test/metadata-project';
        const handle = openSync(filePath, 'w');
        try {
            writeSync(handle, `${JSON.stringify({ type: 'metadata' })}\n`);
            writeSync(handle, `${JSON.stringify({ cwd, timestamp: '2026-08-26T00:00:00.000Z' })}\n`);
        } finally {
            closeSync(handle);
        }

        await expect(readSessionMetadata(filePath)).resolves.toEqual({ cwd, timestamp: '2026-08-26T00:00:00.000Z' });
    });

    it('stops before a cwd beyond the metadata line budget', async () => {
        const filePath = path.join(withTempDir('elepha-metadata-lines-'), 'session.jsonl');
        const handle = openSync(filePath, 'w');
        try {
            for (let line = 0; line < MAX_METADATA_SCAN_LINES; line++) {
                writeSync(handle, '{}\n');
            }
            writeSync(handle, `${JSON.stringify({ cwd: '/Users/test/too-late-by-lines' })}\n`);
        } finally {
            closeSync(handle);
        }

        await expect(readSessionMetadata(filePath)).resolves.toBeUndefined();
    });

    it('stops before buffering a single line that crosses the metadata byte budget', async () => {
        const filePath = path.join(withTempDir('elepha-metadata-bytes-'), 'session.jsonl');
        const handle = openSync(filePath, 'w');
        try {
            writeSync(handle, `${JSON.stringify({ padding: 'x'.repeat(MAX_METADATA_SCAN_BYTES) })}\n`);
            writeSync(handle, `${JSON.stringify({ cwd: '/Users/test/too-late-by-bytes' })}\n`);
        } finally {
            closeSync(handle);
        }

        await expect(readSessionMetadata(filePath)).resolves.toBeUndefined();
    });
});
